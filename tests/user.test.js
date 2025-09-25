const msrp = require("../src/MsrpSdk");

describe("User", () => {
  let MsrpSdk;
  let mockSocket;
  let mockSipSession;
  let mockUri;

  beforeEach(() => {
    // Initialize MSRP SDK with config
    const config = {
      host: "192.168.1.100",
      port: 2855,
      sessionName: "test-session",
      acceptTypes: "text/plain",
      setup: "active",
    };
    MsrpSdk = msrp(config);

    // Mock socket
    mockSocket = {
      write: jest.fn(),
      on: jest.fn(),
      destroy: jest.fn(),
      destroyed: false,
    };

    // Mock SIP session
    mockSipSession = {
      hasMessageCpimAcceptType: jest.fn(),
    };

    // Mock URI constructor and instance
    mockUri = {
      uri: "msrp://192.168.1.100:2855/test-session-123;tcp",
      authority: "192.168.1.100",
      port: "2855",
      sessionId: "test-session-123",
      secure: false,
      transport: "tcp",
    };

    // Store original URI constructor
    const OriginalURI = MsrpSdk.URI;

    // Mock the URI constructor to return our mock
    MsrpSdk.URI = jest.fn().mockReturnValue(mockUri);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("Constructor", () => {
    it("should create a User with all required properties", () => {
      const uri = "msrp://192.168.1.100:2855/test-session-123;tcp";
      const path = "/test/path";

      const user = new MsrpSdk.User(uri, mockSocket, mockSipSession, path);

      expect(MsrpSdk.URI).toHaveBeenCalledWith(uri);
      expect(user.uri).toBe(mockUri);
      expect(user.socket).toBe(mockSocket);
      expect(user.sipSession).toBe(mockSipSession);
      expect(user.fullPath).toBe(path);
    });

    it("should create a User with minimal required parameters", () => {
      const uri = "msrp://example.com:2855/session;tcp";

      const user = new MsrpSdk.User(uri, null, null, null);

      expect(MsrpSdk.URI).toHaveBeenCalledWith(uri);
      expect(user.uri).toBe(mockUri);
      expect(user.socket).toBeNull();
      expect(user.sipSession).toBeNull();
      expect(user.fullPath).toBeNull();
    });

    it("should handle undefined parameters gracefully", () => {
      const uri = "msrp://test.com:2855/test;tcp";

      const user = new MsrpSdk.User(uri);

      expect(MsrpSdk.URI).toHaveBeenCalledWith(uri);
      expect(user.uri).toBe(mockUri);
      expect(user.socket).toBeUndefined();
      expect(user.sipSession).toBeUndefined();
      expect(user.fullPath).toBeUndefined();
    });
  });

  describe("getSocket", () => {
    it("should return the socket", () => {
      const user = new MsrpSdk.User(
        "msrp://test.com:2855/test;tcp",
        mockSocket
      );

      const result = user.getSocket();

      expect(result).toBe(mockSocket);
    });

    it("should return null when socket is null", () => {
      const user = new MsrpSdk.User("msrp://test.com:2855/test;tcp", null);

      const result = user.getSocket();

      expect(result).toBeNull();
    });

    it("should return undefined when socket is undefined", () => {
      const user = new MsrpSdk.User("msrp://test.com:2855/test;tcp");

      const result = user.getSocket();

      expect(result).toBeUndefined();
    });
  });

  describe("getUri", () => {
    it("should return the URI object", () => {
      const user = new MsrpSdk.User("msrp://test.com:2855/test;tcp");

      const result = user.getUri();

      expect(result).toBe(mockUri);
    });

    it("should return the same URI object on multiple calls", () => {
      const user = new MsrpSdk.User("msrp://test.com:2855/test;tcp");

      const result1 = user.getUri();
      const result2 = user.getUri();

      expect(result1).toBe(result2);
      expect(result1).toBe(mockUri);
    });
  });

  describe("getFullPath", () => {
    it("should return the full path", () => {
      const path = "/full/test/path/to/resource";
      const user = new MsrpSdk.User(
        "msrp://test.com:2855/test;tcp",
        null,
        null,
        path
      );

      const result = user.getFullPath();

      expect(result).toBe(path);
    });

    it("should return null when path is null", () => {
      const user = new MsrpSdk.User(
        "msrp://test.com:2855/test;tcp",
        null,
        null,
        null
      );

      const result = user.getFullPath();

      expect(result).toBeNull();
    });

    it("should return undefined when path is undefined", () => {
      const user = new MsrpSdk.User("msrp://test.com:2855/test;tcp");

      const result = user.getFullPath();

      expect(result).toBeUndefined();
    });

    it("should handle empty string path", () => {
      const user = new MsrpSdk.User(
        "msrp://test.com:2855/test;tcp",
        null,
        null,
        ""
      );

      const result = user.getFullPath();

      expect(result).toBe("");
    });
  });

  describe("getSipSession", () => {
    it("should return the SIP session", () => {
      const user = new MsrpSdk.User(
        "msrp://test.com:2855/test;tcp",
        null,
        mockSipSession
      );

      const result = user.getSipSession();

      expect(result).toBe(mockSipSession);
    });

    it("should return null when SIP session is null", () => {
      const user = new MsrpSdk.User(
        "msrp://test.com:2855/test;tcp",
        null,
        null
      );

      const result = user.getSipSession();

      expect(result).toBeNull();
    });

    it("should return undefined when SIP session is undefined", () => {
      const user = new MsrpSdk.User("msrp://test.com:2855/test;tcp");

      const result = user.getSipSession();

      expect(result).toBeUndefined();
    });
  });

  describe("supportsMessageCPIM", () => {
    it("should return true when SIP session supports message CPIM", () => {
      mockSipSession.hasMessageCpimAcceptType.mockReturnValue(true);
      const user = new MsrpSdk.User(
        "msrp://test.com:2855/test;tcp",
        null,
        mockSipSession
      );

      const result = user.supportsMessageCPIM();

      expect(result).toBe(true);
      expect(mockSipSession.hasMessageCpimAcceptType).toHaveBeenCalled();
    });

    it("should return false when SIP session does not support message CPIM", () => {
      mockSipSession.hasMessageCpimAcceptType.mockReturnValue(false);
      const user = new MsrpSdk.User(
        "msrp://test.com:2855/test;tcp",
        null,
        mockSipSession
      );

      const result = user.supportsMessageCPIM();

      expect(result).toBe(false);
      expect(mockSipSession.hasMessageCpimAcceptType).toHaveBeenCalled();
    });

    it("should return false when SIP session is null", () => {
      const user = new MsrpSdk.User(
        "msrp://test.com:2855/test;tcp",
        null,
        null
      );

      const result = user.supportsMessageCPIM();

      expect(result).toBe(false);
    });

    it("should return false when SIP session is undefined", () => {
      const user = new MsrpSdk.User("msrp://test.com:2855/test;tcp");

      const result = user.supportsMessageCPIM();

      expect(result).toBe(false);
    });

    it("should return false when SIP session does not have hasMessageCpimAcceptType method", () => {
      const incompleteSipSession = {};
      const user = new MsrpSdk.User(
        "msrp://test.com:2855/test;tcp",
        null,
        incompleteSipSession
      );

      expect(() => {
        user.supportsMessageCPIM();
      }).toThrow();
    });

    it("should handle SIP session with hasMessageCpimAcceptType that throws error", () => {
      mockSipSession.hasMessageCpimAcceptType.mockImplementation(() => {
        throw new Error("SIP session error");
      });
      const user = new MsrpSdk.User(
        "msrp://test.com:2855/test;tcp",
        null,
        mockSipSession
      );

      expect(() => {
        user.supportsMessageCPIM();
      }).toThrow("SIP session error");
    });
  });

  describe("Integration Tests", () => {
    it("should work correctly with all components together", () => {
      const uri = "msrp://192.168.1.100:2855/integration-test;tcp";
      const path = "/integration/test/path";
      mockSipSession.hasMessageCpimAcceptType.mockReturnValue(true);

      const user = new MsrpSdk.User(uri, mockSocket, mockSipSession, path);

      // Test all getters
      expect(user.getSocket()).toBe(mockSocket);
      expect(user.getUri()).toBe(mockUri);
      expect(user.getFullPath()).toBe(path);
      expect(user.getSipSession()).toBe(mockSipSession);
      expect(user.supportsMessageCPIM()).toBe(true);

      // Verify URI was created with correct parameter
      expect(MsrpSdk.URI).toHaveBeenCalledWith(uri);
      expect(mockSipSession.hasMessageCpimAcceptType).toHaveBeenCalled();
    });

    it("should handle edge case with all null/undefined values", () => {
      const uri = "msrp://minimal.test:2855/minimal;tcp";

      const user = new MsrpSdk.User(uri, null, undefined);

      expect(user.getSocket()).toBeNull();
      expect(user.getUri()).toBe(mockUri);
      expect(user.getFullPath()).toBeUndefined();
      expect(user.getSipSession()).toBeUndefined();
      expect(user.supportsMessageCPIM()).toBe(false);
    });
  });

  describe("Property Access", () => {
    it("should allow direct property access", () => {
      const uri = "msrp://direct.test:2855/direct;tcp";
      const path = "/direct/access/path";

      const user = new MsrpSdk.User(uri, mockSocket, mockSipSession, path);

      // Test direct property access (as used in the implementation)
      expect(user.uri).toBe(mockUri);
      expect(user.socket).toBe(mockSocket);
      expect(user.sipSession).toBe(mockSipSession);
      expect(user.fullPath).toBe(path);
    });
  });
});
