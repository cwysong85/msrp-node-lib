// Create mock net server
let mockNetServer;
let mockConnectionHandler;

// Mock net.createServer before requiring anything else
jest.mock("net", () => {
  const { EventEmitter } = require("events");

  mockNetServer = new EventEmitter();
  mockNetServer.listen = jest.fn((port, host, callback) => {
    // Simulate successful server start
    setImmediate(() => {
      if (callback) callback();
    });
    return mockNetServer;
  });
  mockNetServer.close = jest.fn((callback) => {
    setImmediate(() => {
      if (callback) callback();
    });
  });
  mockNetServer.address = jest.fn(() => ({
    address: "192.168.1.100",
    port: 2855,
  }));

  return {
    createServer: jest.fn((connectionHandler) => {
      mockConnectionHandler = connectionHandler;
      return mockNetServer;
    }),
  };
});

const msrp = require("../src/MsrpSdk");
const net = require("net");
const { EventEmitter } = require("events");

describe("Server", () => {
  let MsrpSdk;
  let server;
  let mockSession;
  let mockSocket;

  beforeEach(() => {
    // Clear all mocks
    jest.clearAllMocks();

    // Reset the mock net server
    mockNetServer.removeAllListeners();

    // Initialize MSRP SDK with config
    const config = {
      host: "192.168.1.100",
      port: 2855,
      sessionName: "test-session",
      acceptTypes: "text/plain",
      setup: "active",
      danglingSocketTimeout: 1000, // Shorter timeout for tests
    };
    MsrpSdk = msrp(config);

    // Create mock socket
    mockSocket = new EventEmitter();
    mockSocket.remoteAddress = "192.168.1.200";
    mockSocket.remotePort = 12345;
    mockSocket.end = jest.fn();
    mockSocket.destroy = jest.fn();

    // Create mock session
    mockSession = {
      sid: "test-session-123",
      setSocket: jest.fn(),
    };

    // Mock SessionController
    MsrpSdk.SessionController = {
      getSessionsByRemoteSocketAddress: jest.fn(() => []),
    };

    // Mock SocketHandler constructor
    MsrpSdk.SocketHandler = jest.fn();

    // Get fresh server instance
    server = MsrpSdk.Server;
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe("Constructor", () => {
    it("should create a Server with TCP server and dangling sockets array", () => {
      expect(net.createServer).toHaveBeenCalledWith(expect.any(Function));
      expect(server.server).toBe(mockNetServer);
      expect(server.danglingSockets).toEqual([]);
      expect(server).toBeInstanceOf(EventEmitter);
    });

    it("should set up connection handler that creates SocketHandler", () => {
      expect(typeof mockConnectionHandler).toBe("function");

      mockConnectionHandler(mockSocket);
      expect(MsrpSdk.SocketHandler).toHaveBeenCalledWith(mockSocket);
    });
  });

  describe("start()", () => {
    it("should start server on configured host and port", (done) => {
      server.start(() => {
        expect(mockNetServer.listen).toHaveBeenCalledWith(
          2855,
          "192.168.1.100",
          expect.any(Function)
        );
        done();
      });
    });

    it("should log server start information", (done) => {
      const infoSpy = jest.spyOn(MsrpSdk.Logger, "info");

      server.start(() => {
        expect(infoSpy).toHaveBeenCalledWith(
          "[MSRP Server] MSRP TCP server listening on 192.168.1.100:2855"
        );
        done();
      });
    });

    it("should log MSRP tracing enabled when traceMsrp is true", (done) => {
      MsrpSdk.Config.traceMsrp = true;
      const infoSpy = jest.spyOn(MsrpSdk.Logger, "info");

      server.start(() => {
        expect(infoSpy).toHaveBeenCalledWith(
          "[MSRP Server] MSRP tracing enabled"
        );
        done();
      });
    });

    it("should not log tracing when traceMsrp is false", (done) => {
      MsrpSdk.Config.traceMsrp = false;
      const infoSpy = jest.spyOn(MsrpSdk.Logger, "info");

      server.start(() => {
        expect(infoSpy).not.toHaveBeenCalledWith(
          "[MSRP Server] MSRP tracing enabled"
        );
        done();
      });
    });

    it("should handle server start without callback", () => {
      expect(() => server.start()).not.toThrow();
      expect(mockNetServer.listen).toHaveBeenCalled();
    });

    it("should handle server error and call callback with error", (done) => {
      const testError = new Error("Server start failed");

      // Mock the listen method to not call the callback immediately - use mockImplementationOnce
      mockNetServer.listen.mockImplementationOnce((port, host, callback) => {
        // Don't call callback immediately, let the error event trigger it
        return mockNetServer;
      });

      server.start((error) => {
        expect(error).toBe(testError);
        done();
      });

      // Simulate server error after a small delay to ensure start() has been called
      setImmediate(() => {
        mockNetServer.emit("error", testError);
      });
    });

    it("should log server error", () => {
      const errorSpy = jest.spyOn(MsrpSdk.Logger, "error");
      const testError = new Error("Server start failed");

      server.start();
      mockNetServer.emit("error", testError);

      expect(errorSpy).toHaveBeenCalledWith(testError);
    });
  });

  describe("Connection handling", () => {
    beforeEach(() => {
      server.start();
    });

    it("should log new socket connection", () => {
      const debugSpy = jest.spyOn(MsrpSdk.Logger, "debug");

      mockNetServer.emit("connection", mockSocket);

      expect(debugSpy).toHaveBeenCalledWith(
        "[MSRP Server] Socket connected. Remote address: 192.168.1.200:12345"
      );
    });

    it("should assign socket to existing session when session is found", () => {
      MsrpSdk.SessionController.getSessionsByRemoteSocketAddress.mockReturnValue(
        [mockSession]
      );

      mockNetServer.emit("connection", mockSocket);

      expect(
        MsrpSdk.SessionController.getSessionsByRemoteSocketAddress
      ).toHaveBeenCalledWith("192.168.1.200:12345");
      expect(mockSession.setSocket).toHaveBeenCalledWith(mockSocket);
      expect(server.danglingSockets).toHaveLength(0);
    });

    it("should handle session setSocket error", () => {
      const errorSpy = jest.spyOn(MsrpSdk.Logger, "error");
      const setSocketError = new Error("Failed to set socket");
      mockSession.setSocket.mockImplementation(() => {
        throw setSocketError;
      });
      MsrpSdk.SessionController.getSessionsByRemoteSocketAddress.mockReturnValue(
        [mockSession]
      );

      mockNetServer.emit("connection", mockSocket);

      expect(errorSpy).toHaveBeenCalledWith(
        "[MSRP Server] Error setting socket for session test-session-123: Error: Failed to set socket"
      );
    });

    it("should add socket to dangling sockets when no session is found", () => {
      const warnSpy = jest.spyOn(MsrpSdk.Logger, "warn");
      MsrpSdk.SessionController.getSessionsByRemoteSocketAddress.mockReturnValue(
        []
      );

      mockNetServer.emit("connection", mockSocket);

      expect(warnSpy).toHaveBeenCalledWith(
        "[MSRP Server] No session found for remote address 192.168.1.200:12345. Waiting for session setup..."
      );
      expect(server.danglingSockets).toContain(mockSocket);
    });

    it("should clean up dangling socket after timeout", (done) => {
      const warnSpy = jest.spyOn(MsrpSdk.Logger, "warn");
      MsrpSdk.SessionController.getSessionsByRemoteSocketAddress.mockReturnValue(
        []
      );

      server.start();
      mockNetServer.emit("connection", mockSocket);
      expect(server.danglingSockets).toContain(mockSocket);

      // Wait for timeout
      setTimeout(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          "[MSRP Server] Dangling socket timeout. Socket with address 192.168.1.200:12345 has not been assigned to any Session. Closing socket..."
        );
        expect(mockSocket.end).toHaveBeenCalled();
        expect(server.danglingSockets).not.toContain(mockSocket);
        done();
      }, 1100); // Wait longer than timeout
    });

    it("should not clean up dangling socket if it was removed before timeout", (done) => {
      MsrpSdk.SessionController.getSessionsByRemoteSocketAddress.mockReturnValue(
        []
      );

      mockNetServer.emit("connection", mockSocket);
      expect(server.danglingSockets).toContain(mockSocket);

      // Remove socket from dangling list before timeout
      const socketIndex = server.danglingSockets.indexOf(mockSocket);
      server.danglingSockets.splice(socketIndex, 1);

      setTimeout(() => {
        expect(mockSocket.end).not.toHaveBeenCalled();
        done();
      }, 1100);
    });

    it("should handle multiple dangling sockets independently", () => {
      const mockSocket2 = new EventEmitter();
      mockSocket2.remoteAddress = "192.168.1.201";
      mockSocket2.remotePort = 12346;
      mockSocket2.end = jest.fn();

      MsrpSdk.SessionController.getSessionsByRemoteSocketAddress.mockReturnValue(
        []
      );

      mockNetServer.emit("connection", mockSocket);
      mockNetServer.emit("connection", mockSocket2);

      expect(server.danglingSockets).toContain(mockSocket);
      expect(server.danglingSockets).toContain(mockSocket2);
      expect(server.danglingSockets).toHaveLength(2);
    });

    it("should use default dangling socket timeout when config is undefined", () => {
      // Remove the timeout from config
      delete MsrpSdk.Config.danglingSocketTimeout;

      // Spy on setTimeout to check the timeout value
      const setTimeoutSpy = jest.spyOn(global, "setTimeout");
      MsrpSdk.SessionController.getSessionsByRemoteSocketAddress.mockReturnValue(
        []
      );

      mockNetServer.emit("connection", mockSocket);

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 20000);

      setTimeoutSpy.mockRestore();
    });
  });

  describe("stop()", () => {
    it("should stop the server with callback", (done) => {
      server.stop((error) => {
        expect(error).toBeUndefined();
        expect(mockNetServer.close).toHaveBeenCalledWith(expect.any(Function));
        done();
      });
    });

    it("should stop the server without callback", () => {
      server.stop();
      expect(mockNetServer.close).toHaveBeenCalledWith();
    });

    it("should handle close callback with error", (done) => {
      const testError = new Error("Close failed");
      mockNetServer.close.mockImplementation((callback) => {
        if (callback) callback(testError);
      });

      server.stop((error) => {
        expect(error).toBe(testError);
        done();
      });
    });
  });

  describe("Integration scenarios", () => {
    it("should handle complete server lifecycle", (done) => {
      let startCallbackCalled = false;

      server.start(() => {
        startCallbackCalled = true;

        // Simulate connection
        mockNetServer.emit("connection", mockSocket);

        server.stop(() => {
          expect(startCallbackCalled).toBe(true);
          expect(mockNetServer.close).toHaveBeenCalled();
          done();
        });
      });
    });

    it("should handle session assignment after socket becomes dangling", () => {
      const warnSpy = jest.spyOn(MsrpSdk.Logger, "warn");

      // Start with no session
      MsrpSdk.SessionController.getSessionsByRemoteSocketAddress.mockReturnValue(
        []
      );
      server.start();
      mockNetServer.emit("connection", mockSocket);

      expect(server.danglingSockets).toContain(mockSocket);
      expect(warnSpy).toHaveBeenCalledWith(
        "[MSRP Server] No session found for remote address 192.168.1.200:12345. Waiting for session setup..."
      );

      // Simulate session becoming available (this would happen in real scenarios)
      // The dangling socket would be picked up by Session.setupConnection
      expect(server.danglingSockets).toHaveLength(1);
    });

    it("should handle error during connection establishment", () => {
      const errorSpy = jest.spyOn(MsrpSdk.Logger, "error");

      server.start();

      // Simulate error during server start
      const testError = new Error("Connection failed");
      mockNetServer.emit("error", testError);

      expect(errorSpy).toHaveBeenCalledWith(testError);
    });
  });

  describe("Edge cases", () => {
    it("should handle socket with undefined remote address", () => {
      const debugSpy = jest.spyOn(MsrpSdk.Logger, "debug");
      mockSocket.remoteAddress = undefined;
      mockSocket.remotePort = undefined;

      server.start();
      mockNetServer.emit("connection", mockSocket);

      expect(debugSpy).toHaveBeenCalledWith(
        "[MSRP Server] Socket connected. Remote address: undefined:undefined"
      );
    });

    it("should handle SessionController returning empty array", () => {
      MsrpSdk.SessionController.getSessionsByRemoteSocketAddress.mockReturnValue(
        []
      );

      server.start();
      mockNetServer.emit("connection", mockSocket);

      expect(server.danglingSockets).toContain(mockSocket);
    });

    it("should handle SessionController returning null", () => {
      MsrpSdk.SessionController.getSessionsByRemoteSocketAddress.mockReturnValue(
        null
      );

      server.start();

      // This should actually throw because the code tries to access [0] on null
      expect(() => mockNetServer.emit("connection", mockSocket)).toThrow();
    });

    it("should handle config without host and port", () => {
      // Create SDK without host/port config
      const minimalConfig = {
        sessionName: "test",
      };
      MsrpSdk.Config = minimalConfig;

      server.start();
      expect(mockNetServer.listen).toHaveBeenCalledWith(
        undefined,
        undefined,
        expect.any(Function)
      );
    });
  });
});
