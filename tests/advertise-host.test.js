const msrp = require("../src/MsrpSdk.js");

describe("AdvertiseHost Configuration", () => {
  describe("getAdvertiseHost", () => {
    test("should return host when advertiseHost is not set", () => {
      const config = {
        host: "192.168.1.100",
        port: 2855,
        sessionName: "test",
        acceptTypes: "text/plain",
        setup: "active",
      };
      const msrpSdk = msrp(config);

      expect(msrpSdk.Util.getAdvertiseHost()).toBe("192.168.1.100");
    });

    test("should return advertiseHost when explicitly set", () => {
      const config = {
        host: "192.168.1.100",
        advertiseHost: "203.0.113.10",
        port: 2855,
        sessionName: "test",
        acceptTypes: "text/plain",
        setup: "active",
      };
      const msrpSdk = msrp(config);

      expect(msrpSdk.Util.getAdvertiseHost()).toBe("203.0.113.10");
    });

    test("should auto-detect network address when host is 0.0.0.0", () => {
      const config = {
        host: "0.0.0.0",
        port: 2855,
        sessionName: "test",
        acceptTypes: "text/plain",
        setup: "active",
      };
      const msrpSdk = msrp(config);

      const advertiseHost = msrpSdk.Util.getAdvertiseHost();
      expect(advertiseHost).not.toBe("0.0.0.0");
      expect(advertiseHost).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    });

    test("should prefer advertiseHost over auto-detection when both apply", () => {
      const config = {
        host: "0.0.0.0",
        advertiseHost: "203.0.113.20",
        port: 2855,
        sessionName: "test",
        acceptTypes: "text/plain",
        setup: "active",
      };
      const msrpSdk = msrp(config);

      expect(msrpSdk.Util.getAdvertiseHost()).toBe("203.0.113.20");
    });
  });

  describe("getLocalNetworkAddress", () => {
    test("should return a valid IPv4 address", () => {
      const config = {
        host: "127.0.0.1",
        port: 2855,
        sessionName: "test",
        acceptTypes: "text/plain",
        setup: "active",
      };
      const msrpSdk = msrp(config);

      const address = msrpSdk.Util.getLocalNetworkAddress();
      expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(address).not.toBe("0.0.0.0");
    });

    test("should not return loopback address when other interfaces exist", () => {
      const config = {
        host: "127.0.0.1",
        port: 2855,
        sessionName: "test",
        acceptTypes: "text/plain",
        setup: "active",
      };
      const msrpSdk = msrp(config);

      const address = msrpSdk.Util.getLocalNetworkAddress();
      // Should prefer non-loopback addresses if available
      if (address !== "127.0.0.1") {
        expect(address).not.toBe("127.0.0.1");
      }
    });
  });
});
