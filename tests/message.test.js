const msrp = require("../src/MsrpSdk.js");

describe("Message Handling", () => {
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

  describe("Message Creation", () => {
    test("should create outgoing request with basic text content", () => {
      const mockSession = {
        toPath: ["msrp://example.com:2855/abc123;tcp"],
        localUri: "msrp://localhost:2855/def456;tcp",
      };

      const message = new msrpSdk.Message.OutgoingRequest(mockSession, "SEND");
      message.addTextBody("Hello World");

      expect(message.body).toBe("Hello World");
      expect(message.tid).toMatch(/^[a-zA-Z0-9]{8}$/);
      expect(message.contentType).toBe("text/plain");
      expect(message.method).toBe("SEND");
    });

    test("should handle different content types", () => {
      const mockSession = {
        toPath: ["msrp://example.com:2855/abc123;tcp"],
        localUri: "msrp://localhost:2855/def456;tcp",
      };

      const message = new msrpSdk.Message.OutgoingRequest(mockSession, "SEND");
      message.addBody("application/json", '{"test": true}');

      expect(message.body).toBe('{"test": true}');
      expect(message.contentType).toBe("application/json");
    });

    test("should handle empty messages", () => {
      const mockSession = {
        toPath: ["msrp://example.com:2855/abc123;tcp"],
        localUri: "msrp://localhost:2855/def456;tcp",
      };

      const message = new msrpSdk.Message.OutgoingRequest(mockSession, "SEND");
      message.addTextBody("");

      expect(message.body).toBe("");
      expect(message.tid).toBeDefined();
    });

    test("should handle large messages", () => {
      const mockSession = {
        toPath: ["msrp://example.com:2855/abc123;tcp"],
        localUri: "msrp://localhost:2855/def456;tcp",
      };

      const largeContent = "A".repeat(10000);
      const message = new msrpSdk.Message.OutgoingRequest(mockSession, "SEND");
      message.addTextBody(largeContent);

      expect(message.body).toBe(largeContent);
      expect(message.body.length).toBe(10000);
    });
  });

  describe("Message Serialization", () => {
    test("should serialize message with correct MSRP format", () => {
      const mockSession = {
        toPath: ["msrp://example.com:2855/abc123;tcp"],
        localUri: "msrp://localhost:2855/def456;tcp",
      };

      const message = new msrpSdk.Message.OutgoingRequest(mockSession, "SEND");
      message.addTextBody("Test content");
      const serialized = message.encode();

      expect(serialized).toMatch(/^MSRP [a-zA-Z0-9]{8} SEND/);
      expect(serialized).toContain("Content-Type: text/plain");
      expect(serialized).toContain("Test content");
      expect(serialized).toMatch(/-------[a-zA-Z0-9]{8}\$[\r\n]*$/);
    });

    test("should include correct headers in serialized message", () => {
      const mockSession = {
        toPath: ["msrp://example.com:2855/abc123;tcp"],
        localUri: "msrp://localhost:2855/def456;tcp",
      };

      const message = new msrpSdk.Message.OutgoingRequest(mockSession, "SEND");
      message.addTextBody("Hello");
      const serialized = message.encode();

      expect(serialized).toContain("To-Path:");
      expect(serialized).toContain("From-Path:");
      expect(serialized).toContain("msrp://example.com:2855/abc123;tcp");
      expect(serialized).toContain("msrp://localhost:2855/def456;tcp");
    });

    test("should handle custom headers", () => {
      const mockSession = {
        toPath: ["msrp://example.com:2855/abc123;tcp"],
        localUri: "msrp://localhost:2855/def456;tcp",
      };

      const message = new msrpSdk.Message.OutgoingRequest(mockSession, "SEND");
      message.addTextBody("Test");
      message.addHeader("X-Custom-Header", "custom-value");
      const serialized = message.encode();

      expect(serialized).toContain("X-Custom-Header: custom-value");
    });
  });

  describe("Message Headers", () => {
    test("should handle header management correctly", () => {
      const mockSession = {
        toPath: ["msrp://example.com:2855/abc123;tcp"],
        localUri: "msrp://localhost:2855/def456;tcp",
      };

      const message = new msrpSdk.Message.OutgoingRequest(mockSession, "SEND");
      message.addHeader("Message-ID", "msg123");
      message.addHeader("X-Custom", "value1");
      message.addHeader("X-Custom", "value2"); // Multiple values

      expect(message.getHeader("Message-ID")).toBe("msg123");
      expect(message.getHeader("X-Custom")).toEqual(["value1", "value2"]);
    });

    test("should normalize header names", () => {
      const mockSession = {
        toPath: ["msrp://example.com:2855/abc123;tcp"],
        localUri: "msrp://localhost:2855/def456;tcp",
      };

      const message = new msrpSdk.Message.OutgoingRequest(mockSession, "SEND");
      message.addHeader("content-type", "application/json");

      expect(message.contentType).toBe("application/json");
    });
  });

  describe("Message End Lines", () => {
    test("should generate correct end line", () => {
      const mockSession = {
        toPath: ["msrp://example.com:2855/abc123;tcp"],
        localUri: "msrp://localhost:2855/def456;tcp",
      };

      const message = new msrpSdk.Message.OutgoingRequest(mockSession, "SEND");
      const endLine = message.getEndLine();

      expect(endLine).toMatch(/-------[a-zA-Z0-9]{8}\$\r\n$/);
    });

    test("should handle continuation flags", () => {
      const mockSession = {
        toPath: ["msrp://example.com:2855/abc123;tcp"],
        localUri: "msrp://localhost:2855/def456;tcp",
      };

      const message = new msrpSdk.Message.OutgoingRequest(mockSession, "SEND");
      message.continuationFlag = msrpSdk.Message.Flag.continued;
      const endLine = message.getEndLine();

      expect(endLine).toMatch(/-------[a-zA-Z0-9]{8}\+\r\n$/);
    });
  });

  describe("Message Types", () => {
    test("should create response messages", () => {
      const response = new msrpSdk.Message.Response();
      response.initResponse();
      response.tid = msrpSdk.Util.newTID();
      response.status = "200";
      response.comment = "OK";

      expect(response.tid).toMatch(/^[a-zA-Z0-9]{8}$/);
      expect(response.status).toBe("200");
      expect(response.comment).toBe("OK");
    });
  });
});
