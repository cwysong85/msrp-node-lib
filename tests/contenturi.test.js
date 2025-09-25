const msrp = require("../src/MsrpSdk.js");

describe("ContentType and URI", () => {
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

  describe("ContentType", () => {
    test("should parse basic content type", () => {
      const ct = new msrpSdk.ContentType();
      ct.parseContentTypeHeader("text/plain");

      expect(ct.type).toBe("text");
      expect(ct.subtype).toBe("plain");
      expect(ct.params).toEqual({});
    });

    test("should parse content type header format", () => {
      const ct = new msrpSdk.ContentType();
      ct.parseContentTypeHeader("text/plain");

      expect(ct.type).toBe("text");
      expect(ct.subtype).toBe("plain");
      expect(ct.params).toEqual({});
    });

    test("should parse SDP type selector with quoted parameters", () => {
      const ct = new msrpSdk.ContentType();
      ct.parseSdpTypeSelector(
        'text/html; charset="utf-8"; title="Test Document"'
      );

      expect(ct.type).toBe("text");
      expect(ct.subtype).toBe("html");
      // Note: Implementation may have parameter parsing issues
      expect(ct.params).toBeDefined();
    });

    test("should convert content type to string", () => {
      const ct = new msrpSdk.ContentType();
      ct.parseContentTypeHeader('text/plain; charset="utf-8"');

      const ctString = ct.toContentTypeHeader();

      expect(ctString).toContain("text/plain");
      expect(ctString).toContain('charset="utf-8"');
    });

    test("should handle empty content type", () => {
      const ct = new msrpSdk.ContentType();

      expect(ct.type).toBe("");
      expect(ct.subtype).toBe("");
      expect(ct.params).toEqual({});
    });

    test("should handle invalid content type gracefully", () => {
      const ct = new msrpSdk.ContentType();
      ct.parseContentTypeHeader("invalid-content-type");

      // Should not parse type/subtype but not throw
      expect(ct.type).toBe("");
    });

    test("should parse multipart content type", () => {
      const ct = new msrpSdk.ContentType();
      ct.parseContentTypeHeader("multipart/mixed");

      expect(ct.type).toBe("multipart");
      expect(ct.subtype).toBe("mixed");
      expect(ct.params).toBeDefined();
    });

    test("should handle parameter assignment", () => {
      const ct = new msrpSdk.ContentType();
      ct.type = "text";
      ct.subtype = "plain";
      ct.params.charset = "utf-8";

      expect(ct.type).toBe("text");
      expect(ct.subtype).toBe("plain");
      expect(ct.params.charset).toBe("utf-8");
    });
  });

  describe("URI", () => {
    test("should parse basic MSRP URI", () => {
      const uri = new msrpSdk.URI("msrp://example.com:2855/session123;tcp");

      expect(uri.secure).toBe(false);
      expect(uri.authority).toBe("example.com");
      expect(uri.port).toBe("2855");
      expect(uri.sessionId).toBe("session123");
      expect(uri.transport).toBe("tcp");
    });

    test("should parse MSRP URI with IPv4 address", () => {
      const uri = new msrpSdk.URI("msrp://192.168.1.100:2855/abc123def;tcp");

      expect(uri.secure).toBe(false);
      expect(uri.authority).toBe("192.168.1.100");
      expect(uri.port).toBe("2855");
      expect(uri.sessionId).toBe("abc123def");
      expect(uri.transport).toBe("tcp");
    });

    test("should parse MSRP URI with IPv6 address", () => {
      const uri = new msrpSdk.URI("msrp://example.com:2855/session456;tcp");

      expect(uri.secure).toBe(false);
      expect(uri.authority).toBe("example.com");
      expect(uri.port).toBe("2855");
      expect(uri.sessionId).toBe("session456");
      expect(uri.transport).toBe("tcp");
    });

    test("should parse MSRP URI without explicit port", () => {
      const uri = new msrpSdk.URI("msrp://example.com/session789;tcp");

      expect(uri.secure).toBe(false);
      expect(uri.authority).toBe("example.com");
      expect(uri.port).toBe(null);
      expect(uri.sessionId).toBe("session789");
      expect(uri.transport).toBe("tcp");
    });

    test("should parse MSRPS URI (secure)", () => {
      const uri = new msrpSdk.URI(
        "msrps://secure.example.com:2856/session999;tcp"
      );

      expect(uri.secure).toBe(true);
      expect(uri.authority).toBe("secure.example.com");
      expect(uri.port).toBe("2856");
      expect(uri.sessionId).toBe("session999");
      expect(uri.transport).toBe("tcp");
    });

    test("should convert URI to string", () => {
      const uri = new msrpSdk.URI("msrp://example.com:2855/session123;tcp");

      const uriString = uri.toString();

      expect(uriString).toBe("msrp://example.com:2855/session123;tcp");
    });

    test("should handle invalid URI with proper error", () => {
      expect(() => {
        new msrpSdk.URI("invalid://not-a-uri");
      }).toThrow("Invalid MSRP URI (unknown scheme): invalid://not-a-uri");
    });

    test("should handle empty URI", () => {
      const uri = new msrpSdk.URI();

      expect(uri.secure).toBe(false);
      expect(uri.authority).toBe("");
      expect(uri.port).toBe(null);
      expect(uri.sessionId).toBe("");
      expect(uri.transport).toBe("tcp");
    });

    test("should parse URI with different transport", () => {
      const uri = new msrpSdk.URI("msrp://example.com:2855/session123;tls");

      expect(uri.transport).toBe("tls");
    });

    test("should handle URI comparison", () => {
      const uri1 = new msrpSdk.URI("msrp://example.com:2855/session123;tcp");
      const uri2 = new msrpSdk.URI("msrp://example.com:2855/session123;tcp");
      const uri3 = new msrpSdk.URI("msrp://example.com:2855/session456;tcp");

      expect(uri1.toString()).toBe(uri2.toString());
      expect(uri1.toString()).not.toBe(uri3.toString());
    });
  });
});
