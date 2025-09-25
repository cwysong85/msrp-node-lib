const msrp = require("../src/MsrpSdk.js");

describe("Parser", () => {
  let msrpSdk;

  beforeEach(() => {
    const config = {
      host: "192.168.1.100",
      port: 2855,
      sessionName: "test",
      acceptTypes: "text/plain",
      setup: "active",
    };
    msrpSdk = msrp(config);
  });

  describe("Message Parsing", () => {
    test("should parse basic SEND request", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg001\r\nByte-Range: 1-11/11\r\nContent-Type: text/plain\r\n\r\nHello World\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.tid).toBe("12345678");
      expect(parsed.method).toBe("SEND");
      expect(parsed.body).toBe("Hello World");
      expect(parsed.contentType).toBe("text/plain");
      expect(parsed.continuationFlag).toBe("$");
      expect(parsed.toPath).toContain("msrp://example.com:2855/session123;tcp");
      expect(parsed.fromPath).toContain("msrp://localhost:2855/session456;tcp");
    });

    test("should parse message with continuation flag", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg001\r\nByte-Range: 1-5/11\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678+\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.body).toBe("Hello");
      expect(parsed.continuationFlag).toBe("+");
    });

    test("should parse message with abort flag", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg001\r\nByte-Range: 1-5/*\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678#\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.body).toBe("Hello");
      expect(parsed.continuationFlag).toBe("#");
    });

    test("should parse 200 OK response", () => {
      const rawMessage = `MSRP 12345678 200 OK\r\nTo-Path: msrp://localhost:2855/session456;tcp\r\nFrom-Path: msrp://example.com:2855/session123;tcp\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.tid).toBe("12345678");
      expect(parsed.status).toBe(200);
      expect(parsed.comment).toBe("OK");
    });

    test("should parse response with just status code", () => {
      const rawMessage = `MSRP 12345678 403\r\nTo-Path: msrp://localhost:2855/session456;tcp\r\nFrom-Path: msrp://example.com:2855/session123;tcp\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.status).toBe(403);
      expect(parsed.comment).toBeUndefined();
    });

    test("should parse REPORT request", () => {
      const rawMessage = `MSRP 87654321 REPORT\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg001\r\nByte-Range: 1-11/11\r\nStatus: 000 200 OK\r\n-------87654321$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.tid).toBe("87654321");
      expect(parsed.method).toBe("REPORT");
      expect(parsed.getHeader("Status")).toBe("000 200 OK");
    });
  });

  describe("Message Body Handling", () => {
    test("should parse message without body", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg001\r\nByte-Range: 1-0/0\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.body).toBeNull();
    });

    test("should handle large message body", () => {
      const largeBody = "A".repeat(10000);
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg001\r\nByte-Range: 1-10000/10000\r\nContent-Type: text/plain\r\n\r\n${largeBody}\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.body).toBe(largeBody);
      expect(parsed.body.length).toBe(10000);
    });

    test("should handle binary data in ArrayBuffer", () => {
      const textData = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg001\r\nByte-Range: 1-5/5\r\nContent-Type: application/octet-stream\r\n\r\nHello\r\n-------12345678$\r\n`;
      const buffer = new ArrayBuffer(textData.length);
      const view = new Uint8Array(buffer);
      for (let i = 0; i < textData.length; i++) {
        view[i] = textData.charCodeAt(i);
      }

      const parsed = msrpSdk.parseMessage(buffer);

      expect(parsed).not.toBeNull();
      expect(parsed.body).toBeInstanceOf(ArrayBuffer);
      expect(parsed.contentType).toBe("application/octet-stream");
    });
  });

  describe("Header Parsing", () => {
    test("should parse custom headers", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg001\r\nX-Custom-Header: custom-value\r\nX-Multi-Header: value1\r\nX-Multi-Header: value2\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.getHeader("X-Custom-Header")).toBe("custom-value");
      expect(parsed.getHeader("X-Multi-Header")).toEqual(["value1", "value2"]);
    });

    test("should handle headers with quoted values", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg001\r\nContent-Type: text/plain; charset="utf-8"\r\nByte-Range: 1-5/5\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.contentType).toBe('text/plain; charset="utf-8"');
    });

    test("should handle whitespace in headers", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path:   msrp://example.com:2855/session123;tcp   \r\nFrom-Path:\tmsrp://localhost:2855/session456;tcp\t\r\nMessage-ID: msg001\r\nByte-Range: 1-5/5\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.toPath[0]).toBe("msrp://example.com:2855/session123;tcp");
      expect(parsed.fromPath[0]).toBe("msrp://localhost:2855/session456;tcp");
    });
  });

  describe("Error Handling", () => {
    test("should return null for invalid first line", () => {
      const rawMessage = `INVALID 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\n\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for message without CRLF", () => {
      const rawMessage = `MSRP 12345678 SEND To-Path: msrp://example.com:2855/session123;tcp`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for header without colon", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path msrp://example.com:2855/session123;tcp\r\n\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for missing end line", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\n\r\nHello World\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for malformed first line tokens", () => {
      const rawMessage = `MSRP\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\n\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for unexpected parameter type", () => {
      const parsed = msrpSdk.parseMessage(123);

      expect(parsed).toBeNull();
    });

    test("should return null for empty transaction ID", () => {
      const rawMessage = `MSRP  SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\n\r\n-------$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for empty method/status", () => {
      const rawMessage = `MSRP 12345678 \r\nTo-Path: msrp://example.com:2855/session123;tcp\r\n\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });
  });

  describe("Different Message Types", () => {
    test("should parse NICKNAME request", () => {
      const rawMessage = `MSRP 12345678 NICKNAME\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nUse-Nickname: Alice\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.method).toBe("NICKNAME");
      expect(parsed.getHeader("Use-Nickname")).toBe("Alice");
    });

    test("should parse various status codes", () => {
      const statusCodes = [200, 400, 403, 404, 408, 413, 415, 481, 501, 506];

      statusCodes.forEach((code) => {
        const rawMessage = `MSRP 12345678 ${code}\r\nTo-Path: msrp://localhost:2855/session456;tcp\r\nFrom-Path: msrp://example.com:2855/session123;tcp\r\n-------12345678$\r\n`;

        const parsed = msrpSdk.parseMessage(rawMessage);

        expect(parsed).not.toBeNull();
        expect(parsed.status).toBe(code);
      });
    });
  });

  describe("Special Header Parsing", () => {
    test("should parse Message-ID header", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.messageId).toBe("msg123");
    });

    test("should parse Byte-Range header", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nByte-Range: 1-100/200\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.byteRange.start).toBe(1);
      expect(parsed.byteRange.end).toBe(100);
      expect(parsed.byteRange.total).toBe(200);
    });

    test("should parse Byte-Range with asterisk values", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nByte-Range: 1-*/*\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.byteRange.start).toBe(1);
      expect(parsed.byteRange.end).toBe(-1);
      expect(parsed.byteRange.total).toBe(-1);
    });

    test("should parse Failure-Report header", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nFailure-Report: yes\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.responseOn.success).toBe(true);
      expect(parsed.responseOn.failure).toBe(true);
    });

    test("should parse Failure-Report header with 'no' value", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nFailure-Report: no\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.responseOn.success).toBe(false);
      expect(parsed.responseOn.failure).toBe(false);
    });

    test("should parse Failure-Report header with 'partial' value", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nFailure-Report: partial\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.responseOn.success).toBe(false);
      expect(parsed.responseOn.failure).toBe(true);
    });

    test("should parse Status header on REPORT", () => {
      const rawMessage = `MSRP 12345678 REPORT\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nStatus: 000 200 Message delivered\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.status).toBe(200);
      expect(parsed.comment).toBe("Message delivered");
    });

    test("should parse Use-Path header", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nUse-Path: msrp://relay1.example.com:2855/session789;tcp msrp://relay2.example.com:2855/session101;tcp\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.usePath).toEqual([
        "msrp://relay1.example.com:2855/session789;tcp",
        "msrp://relay2.example.com:2855/session101;tcp",
      ]);
    });

    test("should parse Expires header", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nExpires: 3600\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.expires).toBe(3600);
    });

    test("should parse Content-Disposition header", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nContent-Disposition: attachment; filename=test.txt; size=1024\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.contentDisposition.type).toBe("attachment");
      expect(parsed.contentDisposition.param.filename).toBe("test.txt");
      expect(parsed.contentDisposition.param.size).toBe("1024");
    });

    test("should parse Content-Disposition with quoted values", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nContent-Disposition: attachment; filename="hello world.txt"\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.contentDisposition.type).toBe("attachment");
      expect(parsed.contentDisposition.param.filename).toBe("hello world.txt");
    });

    test("should parse WWW-Authenticate header", () => {
      const rawMessage = `MSRP 12345678 401\r\nTo-Path: msrp://localhost:2855/session456;tcp\r\nFrom-Path: msrp://example.com:2855/session123;tcp\r\nWWW-Authenticate: Digest realm="example.com", nonce="abc123", algorithm=MD5\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.authenticate).toHaveLength(1);
      expect(parsed.authenticate[0].realm).toBe("example.com");
      expect(parsed.authenticate[0].nonce).toBe("abc123");
      expect(parsed.authenticate[0].algorithm).toBe("MD5");
    });
  });

  describe("Header Parsing Error Cases", () => {
    test("should return null for header without name", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\n: no-name-header\r\n\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for header without value", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nEmpty-Header:\r\n\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for invalid Byte-Range format", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nByte-Range: invalid-format\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for invalid Byte-Range values", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nByte-Range: abc-def/xyz\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for invalid Failure-Report value", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nFailure-Report: invalid\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for invalid Status header format", () => {
      const rawMessage = `MSRP 12345678 REPORT\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nStatus: invalid format\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for Status header without 000 prefix", () => {
      const rawMessage = `MSRP 12345678 REPORT\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nStatus: 123 200 OK\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for invalid Expires header", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nExpires: not-a-number\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for invalid Content-Disposition parameter", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nContent-Disposition: attachment; invalidparam\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for empty Message-ID", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID:   \r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for non-Digest WWW-Authenticate", () => {
      const rawMessage = `MSRP 12345678 401\r\nTo-Path: msrp://localhost:2855/session456;tcp\r\nFrom-Path: msrp://example.com:2855/session123;tcp\r\nWWW-Authenticate: Basic realm="example.com"\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for malformed WWW-Authenticate parameters", () => {
      const rawMessage = `MSRP 12345678 401\r\nTo-Path: msrp://localhost:2855/session456;tcp\r\nFrom-Path: msrp://example.com:2855/session123;tcp\r\nWWW-Authenticate: Digest realm="unterminated string\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for multiple Message-ID headers", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nMessage-ID: msg456\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for multiple Byte-Range headers", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nByte-Range: 1-5/10\r\nByte-Range: 6-10/10\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for multiple Failure-Report headers", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nFailure-Report: yes\r\nFailure-Report: no\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for multiple Status headers", () => {
      const rawMessage = `MSRP 12345678 REPORT\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nStatus: 000 200 OK\r\nStatus: 000 201 OK\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for multiple Use-Path headers", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nUse-Path: msrp://relay1.example.com:2855/session789;tcp\r\nUse-Path: msrp://relay2.example.com:2855/session101;tcp\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for multiple Expires headers", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nExpires: 3600\r\nExpires: 7200\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should return null for multiple Content-Disposition headers", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nContent-Disposition: attachment; filename=test1.txt\r\nContent-Disposition: attachment; filename=test2.txt\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should ignore Status header on response", () => {
      const rawMessage = `MSRP 12345678 200 OK\r\nTo-Path: msrp://localhost:2855/session456;tcp\r\nFrom-Path: msrp://example.com:2855/session123;tcp\r\nStatus: 000 200 OK\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.status).toBe(200);
      expect(parsed.comment).toBe("OK");
    });

    test("should ignore Content-Disposition header on response", () => {
      const rawMessage = `MSRP 12345678 200 OK\r\nTo-Path: msrp://localhost:2855/session456;tcp\r\nFrom-Path: msrp://example.com:2855/session123;tcp\r\nContent-Disposition: attachment; filename=test.txt\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.status).toBe(200);
      expect(parsed.comment).toBe("OK");
    });

    test("should parse empty Use-Path header gracefully", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nUse-Path: \r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.usePath).toEqual([""]);
    });
  });

  describe("Edge Cases and Complex Scenarios", () => {
    test("should handle Min-Expires and Max-Expires headers", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nMin-Expires: 1800\r\nMax-Expires: 7200\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
    });

    test("should handle message with only required headers", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.tid).toBe("12345678");
      expect(parsed.method).toBe("SEND");
      expect(parsed.continuationFlag).toBe("$");
    });

    test("should handle unknown headers gracefully", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nX-Unknown-Header: some-value\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.messageId).toBe("msg123");
      expect(parsed.getHeader("X-Unknown-Header")).toBe("some-value");
    });

    test("should handle WWW-Authenticate with quoted parameters containing commas", () => {
      const rawMessage = `MSRP 12345678 401\r\nTo-Path: msrp://localhost:2855/session456;tcp\r\nFrom-Path: msrp://example.com:2855/session123;tcp\r\nWWW-Authenticate: Digest realm="example.com", nonce="abc,123,xyz"\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.authenticate).toHaveLength(1);
      expect(parsed.authenticate[0].realm).toBe("example.com");
      expect(parsed.authenticate[0].nonce).toBe("abc,123,xyz");
    });

    test("should handle WWW-Authenticate with empty parameters", () => {
      const rawMessage = `MSRP 12345678 401\r\nTo-Path: msrp://localhost:2855/session456;tcp\r\nFrom-Path: msrp://example.com:2855/session123;tcp\r\nWWW-Authenticate: Digest =value, name=\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should handle WWW-Authenticate without closing quote", () => {
      const rawMessage = `MSRP 12345678 401\r\nTo-Path: msrp://localhost:2855/session456;tcp\r\nFrom-Path: msrp://example.com:2855/session123;tcp\r\nWWW-Authenticate: Digest realm="unclosed\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should handle WWW-Authenticate with parameters without equals", () => {
      const rawMessage = `MSRP 12345678 401\r\nTo-Path: msrp://localhost:2855/session456;tcp\r\nFrom-Path: msrp://example.com:2855/session123;tcp\r\nWWW-Authenticate: Digest realm\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should handle message where first line has too few tokens", () => {
      const rawMessage = `MSRP 12345678\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\n\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should handle message where method has 4 characters but isn't numeric (not response)", () => {
      const rawMessage = `MSRP 12345678 ABCD TEST\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should handle header parsing with value that has colon but no newline", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nMalformed-Header: value with no ending`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });

    test("should handle header parsing where name length check is wrong", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nEmpty-Name: value\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.getHeader("Empty-Name")).toBe("value");
    });

    test("should handle edge case with String object vs string primitive", () => {
      const rawMessage = new String(
        `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`
      );

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.body).toBe("Hello");
    });

    test("should handle Content-Disposition with empty split value", () => {
      const rawMessage = `MSRP 12345678 SEND\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nContent-Disposition: \r\nByte-Range: 1-5/5\r\nContent-Type: text/plain\r\n\r\nHello\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).not.toBeNull();
      expect(parsed.contentDisposition.type).toBe("");
    });

    test("should handle Status header with only one token", () => {
      const rawMessage = `MSRP 12345678 REPORT\r\nTo-Path: msrp://example.com:2855/session123;tcp\r\nFrom-Path: msrp://localhost:2855/session456;tcp\r\nMessage-ID: msg123\r\nStatus: 000\r\n-------12345678$\r\n`;

      const parsed = msrpSdk.parseMessage(rawMessage);

      expect(parsed).toBeNull();
    });
  });
});
