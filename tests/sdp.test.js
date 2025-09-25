const msrp = require("../src/MsrpSdk.js");

describe("SDP", () => {
  let msrpSdk;

  beforeEach(() => {
    const config = {
      host: "192.168.1.100",
      advertiseHost: "203.0.113.10",
      port: 2855,
      sessionName: "test-session",
      acceptTypes: "text/plain",
      setup: "active",
    };
    msrpSdk = msrp(config);
  });

  describe("SDP Session Creation", () => {
    test("should create empty SDP session with defaults", () => {
      const sdp = new msrpSdk.Sdp.Session();

      expect(sdp.version).toBe(0);
      expect(sdp.sessionName).toBe(" ");
      expect(sdp.origin).toBeDefined();
      expect(sdp.connection).toBeDefined();
      expect(sdp.timing).toHaveLength(1);
      expect(sdp.media).toEqual([]);
      expect(sdp.attributes).toBeDefined();
    });

    test("should parse valid SDP string", () => {
      const sdpString = `v=0\r\no=- 123456 123456 IN IP4 192.168.1.100\r\ns=MSRP Session\r\nc=IN IP4 192.168.1.100\r\nt=0 0\r\nm=message 2855 TCP/MSRP *\r\na=accept-types:text/plain\r\na=path:msrp://192.168.1.100:2855/session123;tcp\r\na=setup:active\r\n`;

      const sdp = new msrpSdk.Sdp.Session(sdpString);

      expect(sdp).not.toBeNull();
      expect(sdp.version).toBe(0);
      expect(sdp.sessionName).toBe("MSRP Session");
      expect(sdp.origin.address).toBe("192.168.1.100");
      expect(sdp.connection.address).toBe("192.168.1.100");
      expect(sdp.media).toHaveLength(1);
      expect(sdp.media[0].attributes["accept-types"]).toContain("text/plain");
      expect(sdp.media[0].attributes["setup"]).toContain("active");
    });

    test("should return object with defaults for invalid SDP string", () => {
      const invalidSdp = `invalid sdp content`;

      const sdp = new msrpSdk.Sdp.Session(invalidSdp);

      // Invalid SDP returns object with default values, not null
      expect(sdp).not.toBeNull();
      expect(sdp.version).toBe(0);
      expect(sdp.sessionName).toBe(" ");
      expect(sdp.connection.address).toBe("address.invalid");
    });
  });

  describe("SDP Attributes", () => {
    test("should add single attribute", () => {
      const sdp = new msrpSdk.Sdp.Session();

      sdp.addAttribute("accept-types", "text/plain");

      expect(sdp.attributes["accept-types"]).toContain("text/plain");
      expect(sdp.attributeNameOrder).toContain("accept-types");
    });

    test("should add multiple values to same attribute", () => {
      const sdp = new msrpSdk.Sdp.Session();

      sdp.addAttribute("accept-types", "text/plain application/json");

      expect(sdp.attributes["accept-types"]).toContain("text/plain");
      expect(sdp.attributes["accept-types"]).toContain("application/json");
    });

    test("should remove attribute", () => {
      const sdp = new msrpSdk.Sdp.Session();
      sdp.addAttribute("test-attr", "value");

      sdp.removeAttribute("test-attr");

      expect(sdp.attributes["test-attr"]).toBeUndefined();
    });

    test("should handle setup attribute correctly", () => {
      const sdp = new msrpSdk.Sdp.Session();

      sdp.addAttribute("setup", "active");
      expect(sdp.attributes.setup).toContain("active");

      sdp.addAttribute("setup", "passive");
      expect(sdp.attributes.setup).toContain("passive");
    });
  });

  describe("SDP Origin", () => {
    test("should create origin with default values", () => {
      const origin = new msrpSdk.Sdp.Origin();

      expect(origin.username).toBe("-");
      expect(origin.netType).toBe("IN");
      expect(origin.addrType).toBe("IP4");
      expect(origin.address).toBe("address.invalid");
      expect(typeof origin.id).toBe("number");
    });

    test("should parse origin line", () => {
      const origin = new msrpSdk.Sdp.Origin(
        "alice 123456 789012 IN IP4 192.168.1.100"
      );

      expect(origin.username).toBe("alice");
      expect(origin.id).toBe("123456");
      expect(origin.version).toBe("789012");
      expect(origin.netType).toBe("IN");
      expect(origin.addrType).toBe("IP4");
      expect(origin.address).toBe("192.168.1.100");
    });

    test("should convert origin to string", () => {
      const origin = new msrpSdk.Sdp.Origin(
        "alice 123456 789012 IN IP4 192.168.1.100"
      );

      const originString = origin.toString();

      expect(originString).toBe("alice 123456 789012 IN IP4 192.168.1.100");
    });

    test("should return empty object for invalid origin line", () => {
      const origin = new msrpSdk.Sdp.Origin("invalid origin");

      expect(origin).toEqual({});
    });
  });

  describe("SDP Connection", () => {
    test("should create connection with default values", () => {
      const connection = new msrpSdk.Sdp.Connection();

      expect(connection.netType).toBe("IN");
      expect(connection.addrType).toBe("IP4");
      expect(connection.address).toBe("address.invalid");
    });

    test("should parse connection line", () => {
      const connection = new msrpSdk.Sdp.Connection("IN IP4 192.168.1.100");

      expect(connection.netType).toBe("IN");
      expect(connection.addrType).toBe("IP4");
      expect(connection.address).toBe("192.168.1.100");
    });

    test("should convert connection to string", () => {
      const connection = new msrpSdk.Sdp.Connection("IN IP4 192.168.1.100");

      const connectionString = connection.toString();

      expect(connectionString).toBe("IN IP4 192.168.1.100");
    });

    test("should return empty object for invalid connection line", () => {
      const connection = new msrpSdk.Sdp.Connection("invalid");

      expect(connection).toEqual({});
    });
  });

  describe("SDP Timing", () => {
    test("should create timing with default values", () => {
      const timing = new msrpSdk.Sdp.Timing();

      expect(timing.start).toBe(null);
      expect(timing.stop).toBe(null);
      expect(timing.repeat).toEqual([]);
    });

    test("should parse timing line", () => {
      const timing = new msrpSdk.Sdp.Timing("123456 789012");

      expect(timing.start).toBeInstanceOf(Date);
      expect(timing.stop).toBeInstanceOf(Date);
      expect(timing.repeat).toEqual([]);
    });

    test("should convert timing to string", () => {
      const timing = new msrpSdk.Sdp.Timing("123456 789012");

      const timingString = timing.toString();

      expect(timingString).toBe("123456 789012");
    });

    test("should return empty object for invalid timing line", () => {
      const timing = new msrpSdk.Sdp.Timing("invalid");

      expect(timing).toEqual({});
    });
  });

  describe("SDP Media", () => {
    test("should parse media description", () => {
      const media = new msrpSdk.Sdp.Media("message 2855 TCP/MSRP *");

      expect(media.media).toBe("message");
      expect(media.port).toBe(2855);
      expect(media.proto).toBe("TCP/MSRP");
      expect(media.format).toBe("*");
      expect(media.attributes).toBeDefined();
    });

    test("should add attributes to media", () => {
      const media = new msrpSdk.Sdp.Media(
        "message 2855 TCP/MSRP *\r\na=accept-types:text/plain\r\na=path:msrp://192.168.1.100:2855/session123;tcp"
      );

      expect(media.attributes["accept-types"]).toContain("text/plain");
      expect(media.attributes.path).toContain(
        "msrp://192.168.1.100:2855/session123;tcp"
      );
    });

    test("should convert media to string", () => {
      const media = new msrpSdk.Sdp.Media("message 2855 TCP/MSRP *");

      const mediaString = media.toString();

      expect(mediaString).toContain("message 2855 TCP/MSRP *");
    });

    test("should return object for invalid media line", () => {
      const media = new msrpSdk.Sdp.Media("invalid");

      expect(media).not.toBeNull();
      expect(media.media).toBe("message");
      expect(media.port).toBe(2855);
      expect(media.proto).toBe("TCP/MSRP");
    });
  });

  describe("SDP String Generation", () => {
    test("should generate complete SDP string", () => {
      const sdp = new msrpSdk.Sdp.Session();
      sdp.sessionName = "Test Session";
      sdp.origin.address = "192.168.1.100";
      sdp.connection.address = "192.168.1.100";
      sdp.addAttribute("accept-types", "text/plain");
      sdp.addAttribute("setup", "active");
      sdp.addAttribute("path", "msrp://192.168.1.100:2855/session123;tcp");
      sdp.media.push("message 2855 TCP/MSRP *");

      const sdpString = sdp.toString();

      expect(sdpString).toContain("v=0");
      expect(sdpString).toContain("s=Test Session");
      expect(sdpString).toContain("c=IN IP4 192.168.1.100");
      expect(sdpString).toContain("m=message 2855 TCP/MSRP *");
      expect(sdpString).toContain("a=accept-types:text/plain");
      expect(sdpString).toContain("a=setup:active");
      expect(sdpString).toContain(
        "a=path:msrp://192.168.1.100:2855/session123;tcp"
      );
    });

    test("should handle empty media array", () => {
      const sdp = new msrpSdk.Sdp.Session();

      const sdpString = sdp.toString();

      expect(sdpString).toContain("v=0");
      expect(sdpString).toContain("t=0 0");
      expect(sdpString).not.toContain("m=");
    });

    test("should maintain attribute order", () => {
      const sdp = new msrpSdk.Sdp.Session();
      sdp.addAttribute("setup", "active");
      sdp.addAttribute("accept-types", "text/plain");
      sdp.addAttribute("path", "msrp://192.168.1.100:2855/session123;tcp");

      const sdpString = sdp.toString();

      const setupIndex = sdpString.indexOf("a=setup:active");
      const acceptIndex = sdpString.indexOf("a=accept-types:text/plain");
      const pathIndex = sdpString.indexOf("a=path:msrp://");

      expect(setupIndex).toBeLessThan(acceptIndex);
      expect(acceptIndex).toBeLessThan(pathIndex);
    });
  });

  describe("SDP Parsing Edge Cases", () => {
    test("should reject SDP with extra whitespace in version", () => {
      const sdpString = `v=0  \r\no=-  123456 123456 IN IP4 192.168.1.100  \r\ns=MSRP Session  \r\nc=IN IP4 192.168.1.100  \r\nt=0 0  \r\n`;

      const sdp = new msrpSdk.Sdp.Session(sdpString);

      // SDP with extra whitespace in version line is invalid and gets defaults
      expect(sdp).not.toBeNull();
      expect(sdp.sessionName).toBe(" ");
      expect(sdp.connection.address).toBe("address.invalid");
    });

    test("should handle SDP with missing optional fields", () => {
      const sdpString = `v=0\r\no=- 123456 123456 IN IP4 192.168.1.100\r\ns=-\r\nt=0 0\r\n`;

      const sdp = new msrpSdk.Sdp.Session(sdpString);

      expect(sdp).not.toBeNull();
      expect(sdp.sessionName).toBe("-");
    });

    test("should reject SDP with invalid version", () => {
      const sdpString = `v=1\r\no=- 123456 123456 IN IP4 192.168.1.100\r\ns=MSRP Session\r\nc=IN IP4 192.168.1.100\r\nt=0 0\r\n`;

      const sdp = new msrpSdk.Sdp.Session(sdpString);

      // Invalid version returns object with defaults, not null
      expect(sdp).not.toBeNull();
      expect(sdp.version).toBe(0);
      expect(sdp.sessionName).toBe(" ");
      expect(sdp.connection.address).toBe("address.invalid");
    });
  });
});
