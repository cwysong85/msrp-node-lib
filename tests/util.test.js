const msrp = require("../src/MsrpSdk.js");

describe("Util Functions", () => {
  let msrpInstance;

  beforeEach(() => {
    const config = {
      host: "127.0.0.1",
      port: 2855,
      sessionName: "test",
      acceptTypes: "text/plain",
      setup: "active",
    };
    msrpInstance = msrp(config);
  });

  describe("newSID", () => {
    test("should generate a unique session ID", () => {
      const sid1 = msrpInstance.Util.newSID();
      const sid2 = msrpInstance.Util.newSID();

      expect(sid1).toBeDefined();
      expect(sid2).toBeDefined();
      expect(sid1).not.toBe(sid2);
      expect(sid1).toMatch(/^[a-z0-9]+$/);
      expect(sid1.length).toBe(10);
    });
  });

  describe("newTID", () => {
    test("should generate a unique transaction ID", () => {
      const tid1 = msrpInstance.Util.newTID();
      const tid2 = msrpInstance.Util.newTID();

      expect(tid1).toBeDefined();
      expect(tid2).toBeDefined();
      expect(tid1).not.toBe(tid2);
      expect(tid1).toMatch(/^[a-z0-9]+$/);
      expect(tid1.length).toBe(8);
    });
  });

  describe("newMID", () => {
    test("should generate a unique message ID", () => {
      const mid1 = msrpInstance.Util.newMID();
      const mid2 = msrpInstance.Util.newMID();

      expect(mid1).toBeDefined();
      expect(mid2).toBeDefined();
      expect(mid1).not.toBe(mid2);
      expect(mid1).toMatch(/^\d+\.[a-z0-9]+$/);
    });
  });

  describe("normaliseHeader", () => {
    test("should normalize header names correctly", () => {
      expect(msrpInstance.Util.normaliseHeader("content-type")).toBe(
        "Content-Type"
      );
      expect(msrpInstance.Util.normaliseHeader("CONTENT-TYPE")).toBe(
        "Content-Type"
      );
      expect(msrpInstance.Util.normaliseHeader("message-id")).toBe(
        "Message-ID"
      );
      expect(msrpInstance.Util.normaliseHeader("www-authenticate")).toBe(
        "WWW-Authenticate"
      );
    });
  });

  describe("isEmpty", () => {
    test("should detect empty objects", () => {
      expect(msrpInstance.Util.isEmpty({})).toBe(true);
      expect(msrpInstance.Util.isEmpty({ key: "value" })).toBe(false);
      expect(msrpInstance.Util.isEmpty({ key: null })).toBe(false);
    });
  });

  describe("byteLength", () => {
    test("should calculate UTF-8 byte length correctly", () => {
      expect(msrpInstance.Util.byteLength("hello")).toBe(5);
      expect(msrpInstance.Util.byteLength("héllo")).toBe(6); // é is 2 bytes
      expect(msrpInstance.Util.byteLength("")).toBe(0);
    });
  });

  describe("encodeSdpFileName and decodeSdpFileName", () => {
    test("should encode and decode SDP filenames", () => {
      const original = 'test file "with quotes".txt';
      const encoded = msrpInstance.Util.encodeSdpFileName(original);
      const decoded = msrpInstance.Util.decodeSdpFileName(encoded);

      expect(encoded).toBe("test file %22with quotes%22.txt");
      expect(decoded).toBe(original);
    });
  });
});
