const msrp = require("../src/MsrpSdk.js");
const net = require("net");
const { EventEmitter } = require("events");

describe("SocketHandler", () => {
  let msrpSdk;
  let mockSocket;
  let mockSession;

  beforeEach(() => {
    const config = {
      host: "192.168.1.100",
      port: 2855,
      sessionName: "test-session",
      acceptTypes: "text/plain",
      setup: "active",
      idleSocketTimeout: 30000,
      traceMsrp: true,
      useInboundMessageForSocketSetup: true,
    };
    msrpSdk = msrp(config);

    // Create mock socket
    mockSocket = new EventEmitter();
    mockSocket.setEncoding = jest.fn();
    mockSocket.setTimeout = jest.fn();
    mockSocket.write = jest.fn();
    mockSocket.read_buffer = "";
    mockSocket.destroyed = false;

    // Create mock session
    mockSession = new EventEmitter();
    mockSession.sid = "test-session-123";
    mockSession.localEndpoint = {
      uri: "msrp://192.168.1.100:2855/test-session-123;tcp",
    };
    mockSession.remoteEndpoints = [
      "msrp://remote.example.com:2855/remote-session;tcp",
    ];
    mockSession.socket = null;
    mockSession.setSocket = jest.fn();
    mockSession.remoteSdp = { attributes: {} };
    mockSession.heartbeatsTransIds = {};

    // Mock SessionController
    msrpSdk.SessionController = msrpSdk.SessionController || {};
    msrpSdk.SessionController.getSession = jest
      .fn()
      .mockReturnValue(mockSession);

    // Mock Server
    msrpSdk.Server = msrpSdk.Server || {};
    msrpSdk.Server.danglingSockets = [];

    // Mock parseMessage function
    msrpSdk.parseMessage = jest.fn();

    // Mock Message classes
    msrpSdk.Message = msrpSdk.Message || {};
    msrpSdk.Message.Flag = { end: "$", continued: "+", interrupted: "#" };
    msrpSdk.Message.OutgoingResponse = jest
      .fn()
      .mockImplementation((req, toUri, status) => ({
        encode: jest
          .fn()
          .mockReturnValue(
            `MSRP ${req.tid} ${status} OK\r\n-------${req.tid}$\r\n`
          ),
      }));
    msrpSdk.Message.OutgoingRequest = jest.fn().mockReturnValue({
      encode: jest
        .fn()
        .mockReturnValue("MSRP 12345678 REPORT\r\n-------12345678$\r\n"),
      addHeader: jest.fn(),
    });

    // Mock Status constants
    msrpSdk.Status = {
      OK: 200,
      BAD_REQUEST: 400,
      FORBIDDEN: 403,
      SESSION_DOES_NOT_EXIST: 481,
      NOT_IMPLEMENTED: 501,
      STOP_SENDING: 413,
    };
    msrpSdk.StatusComment = {
      200: "OK",
      400: "Bad Request",
      403: "Forbidden",
      481: "Session Does Not Exist",
      501: "Not Implemented",
      413: "Stop Sending Message",
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("Socket Initialization", () => {
    test("should initialize socket with proper encoding and timeout", () => {
      const socketHandler = new msrpSdk.SocketHandler(mockSocket);

      expect(mockSocket.setEncoding).toHaveBeenCalledWith("utf8");
      expect(mockSocket.setTimeout).toHaveBeenCalledWith(30000);
      expect(mockSocket.read_buffer).toBe("");
    });

    test("should not set timeout when idleSocketTimeout is 0", () => {
      msrpSdk.Config.idleSocketTimeout = 0;
      const socketHandler = new msrpSdk.SocketHandler(mockSocket);

      expect(mockSocket.setEncoding).toHaveBeenCalledWith("utf8");
      expect(mockSocket.setTimeout).not.toHaveBeenCalled();
    });

    test("should return the socket object", () => {
      const result = new msrpSdk.SocketHandler(mockSocket);
      expect(result).toBe(mockSocket);
    });
  });

  describe("Data Handling", () => {
    test("should handle incoming MSRP data and parse messages", () => {
      const mockParsedMessage = {
        tid: "12345678",
        method: "SEND",
        toPath: ["msrp://192.168.1.100:2855/test-session-123;tcp"],
        fromPath: ["msrp://remote.example.com:2855/remote-session;tcp"],
        messageId: "msg-123",
        body: "Hello World",
        byteRange: { start: 1, end: 11, total: 11 },
        continuationFlag: "$",
      };

      msrpSdk.parseMessage.mockReturnValue(mockParsedMessage);

      const socketHandler = new msrpSdk.SocketHandler(mockSocket);

      const msrpMessage =
        "MSRP 12345678 SEND\r\n" +
        "To-Path: msrp://192.168.1.100:2855/test-session-123;tcp\r\n" +
        "From-Path: msrp://remote.example.com:2855/remote-session;tcp\r\n" +
        "Message-ID: msg-123\r\n" +
        "Content-Type: text/plain\r\n" +
        "\r\n" +
        "Hello World\r\n" +
        "-------12345678$\r\n";

      mockSocket.emit("data", msrpMessage);

      expect(msrpSdk.parseMessage).toHaveBeenCalled();
      // Message should be processed and removed from buffer
      expect(mockSocket.read_buffer).toBe("");
    });

    test("should handle malformed messages gracefully", () => {
      const socketHandler = new msrpSdk.SocketHandler(mockSocket);

      // The regex in SocketHandler looks for complete MSRP messages
      // An invalid message that matches the regex but fails parsing
      const invalidMessage = "MSRP 12345678 INVALID\r\n-------12345678$\r\n";

      msrpSdk.parseMessage.mockReturnValue(null);

      // Spy on Logger.warn
      const warnSpy = jest.spyOn(msrpSdk.Logger, "warn").mockImplementation();

      mockSocket.emit("data", invalidMessage);

      expect(msrpSdk.parseMessage).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Unable to parse incoming message")
      );

      warnSpy.mockRestore();
    });

    test("should accumulate data in read buffer for incomplete messages", () => {
      const socketHandler = new msrpSdk.SocketHandler(mockSocket);

      // Send partial data
      mockSocket.emit("data", "MSRP 12345678 SEND\r\n");
      expect(mockSocket.read_buffer).toBe("MSRP 12345678 SEND\r\n");

      // Send more data
      mockSocket.emit("data", "To-Path: msrp://test;tcp\r\n");
      expect(mockSocket.read_buffer).toBe(
        "MSRP 12345678 SEND\r\nTo-Path: msrp://test;tcp\r\n"
      );
    });
  });

  describe("Request Handling", () => {
    test("should handle SEND request with valid session", () => {
      const mockParsedMessage = {
        tid: "12345678",
        method: "SEND",
        toPath: ["msrp://192.168.1.100:2855/test-session-123;tcp"],
        fromPath: ["msrp://remote.example.com:2855/remote-session;tcp"],
        messageId: "msg-123",
        body: "Hello World",
        byteRange: { start: 1, end: 11, total: 11 },
        continuationFlag: "$",
      };

      msrpSdk.parseMessage.mockReturnValue(mockParsedMessage);
      mockSession.socket = mockSocket; // Session has socket set

      const socketHandler = new msrpSdk.SocketHandler(mockSocket);
      const msrpMessage =
        "MSRP 12345678 SEND\r\n" +
        "To-Path: msrp://192.168.1.100:2855/test-session-123;tcp\r\n" +
        "From-Path: msrp://remote.example.com:2855/remote-session;tcp\r\n" +
        "Message-ID: msg-123\r\n" +
        "Byte-Range: 1-11/11\r\n" +
        "Content-Type: text/plain\r\n" +
        "\r\n" +
        "Hello World\r\n" +
        "-------12345678$\r\n";

      const emitSpy = jest.spyOn(mockSession, "emit");
      mockSocket.emit("data", msrpMessage);

      expect(emitSpy).toHaveBeenCalledWith(
        "message",
        mockParsedMessage,
        mockSession,
        msrpMessage
      );
      expect(mockSocket.write).toHaveBeenCalled(); // Response should be sent
    });

    test("should return 400 BAD REQUEST for malformed To-Path", () => {
      // Mock URI constructor to throw error for invalid URI
      const originalURI = msrpSdk.URI;
      msrpSdk.URI = jest.fn().mockImplementation((uri) => {
        if (uri === "invalid-uri") {
          throw new TypeError("Invalid MSRP URI: invalid-uri");
        }
        return new originalURI(uri);
      });

      const mockParsedMessage = {
        tid: "12345678",
        method: "SEND",
        toPath: ["invalid-uri"],
        fromPath: ["msrp://remote.example.com:2855/remote-session;tcp"],
        messageId: "msg-123",
      };

      msrpSdk.parseMessage.mockReturnValue(mockParsedMessage);

      const socketHandler = new msrpSdk.SocketHandler(mockSocket);
      const msrpMessage = "MSRP 12345678 SEND\r\n-------12345678$\r\n";

      mockSocket.emit("data", msrpMessage);

      expect(mockSocket.write).toHaveBeenCalled();
      // Check that a 400 response was sent
      const writeCall = mockSocket.write.mock.calls[0][0];
      expect(writeCall).toContain("400");

      // Restore original URI
      msrpSdk.URI = originalURI;
    });

    test("should return 481 SESSION DOES NOT EXIST for unknown session", () => {
      const mockParsedMessage = {
        tid: "12345678",
        method: "SEND",
        toPath: ["msrp://192.168.1.100:2855/unknown-session;tcp"],
        fromPath: ["msrp://remote.example.com:2855/remote-session;tcp"],
        messageId: "msg-123",
      };

      msrpSdk.parseMessage.mockReturnValue(mockParsedMessage);
      msrpSdk.SessionController.getSession.mockReturnValue(null); // Session not found

      const socketHandler = new msrpSdk.SocketHandler(mockSocket);
      const msrpMessage = "MSRP 12345678 SEND\r\n-------12345678$\r\n";

      mockSocket.emit("data", msrpMessage);

      expect(mockSocket.write).toHaveBeenCalled();
      const writeCall = mockSocket.write.mock.calls[0][0];
      expect(writeCall).toContain("481");
    });

    test("should set socket for session when useInboundMessageForSocketSetup is true", () => {
      const mockParsedMessage = {
        tid: "12345678",
        method: "SEND",
        toPath: ["msrp://192.168.1.100:2855/test-session-123;tcp"],
        fromPath: ["msrp://remote.example.com:2855/remote-session;tcp"],
        messageId: "msg-123",
        body: "Hello World",
        byteRange: { start: 1, end: 11, total: 11 },
        continuationFlag: "$",
      };

      msrpSdk.parseMessage.mockReturnValue(mockParsedMessage);
      mockSession.socket = null; // Session has no socket yet

      const socketHandler = new msrpSdk.SocketHandler(mockSocket);
      const msrpMessage = "MSRP 12345678 SEND\r\n-------12345678$\r\n";

      mockSocket.emit("data", msrpMessage);

      expect(mockSession.setSocket).toHaveBeenCalledWith(mockSocket, false);
    });

    test("should handle REPORT request", () => {
      const mockParsedMessage = {
        tid: "12345678",
        method: "REPORT",
        toPath: ["msrp://192.168.1.100:2855/test-session-123;tcp"],
        fromPath: ["msrp://remote.example.com:2855/remote-session;tcp"],
        messageId: "msg-123",
        status: "200 OK",
      };

      const errorSpy = jest.spyOn(msrpSdk.Logger, "error");

      msrpSdk.parseMessage.mockReturnValue(mockParsedMessage);
      mockSession.socket = mockSocket;

      const socketHandler = new msrpSdk.SocketHandler(mockSocket);
      const msrpMessage = "MSRP 12345678 REPORT\r\n-------12345678$\r\n";

      mockSocket.emit("data", msrpMessage);

      // REPORT messages don't require responses, and with no chunk sender,
      // it should log an error about unknown message ID
      expect(errorSpy).toHaveBeenCalledWith(
        "[MSRP SocketHandler] Invalid REPORT: Unknown message ID"
      );
      expect(mockSocket.write).not.toHaveBeenCalled(); // REPORT messages don't send responses

      errorSpy.mockRestore();
    });

    test("should return 501 NOT IMPLEMENTED for unknown method", () => {
      const mockParsedMessage = {
        tid: "12345678",
        method: "UNKNOWN",
        toPath: ["msrp://192.168.1.100:2855/test-session-123;tcp"],
        fromPath: ["msrp://remote.example.com:2855/remote-session;tcp"],
        messageId: "msg-123",
      };

      msrpSdk.parseMessage.mockReturnValue(mockParsedMessage);
      mockSession.socket = mockSocket;

      const socketHandler = new msrpSdk.SocketHandler(mockSocket);
      const msrpMessage = "MSRP 12345678 UNKNOWN\r\n-------12345678$\r\n";

      mockSocket.emit("data", msrpMessage);

      expect(mockSocket.write).toHaveBeenCalled();
      const writeCall = mockSocket.write.mock.calls[0][0];
      expect(writeCall).toContain("501");
    });
  });

  describe("Response Handling", () => {
    test("should handle incoming response messages", () => {
      const mockParsedMessage = {
        tid: "12345678",
        status: "200",
        comment: "OK",
        toPath: ["msrp://192.168.1.100:2855/test-session-123;tcp"],
        fromPath: ["msrp://remote.example.com:2855/remote-session;tcp"],
      };

      msrpSdk.parseMessage.mockReturnValue(mockParsedMessage);
      mockSession.heartbeatsTransIds = { 12345678: true };

      const socketHandler = new msrpSdk.SocketHandler(mockSocket);
      const msrpMessage = "MSRP 12345678 200 OK\r\n-------12345678$\r\n";

      // Should handle response without throwing
      expect(() => {
        mockSocket.emit("data", msrpMessage);
      }).not.toThrow();
    });
  });

  describe("Message Sending", () => {
    test("should add message to send queue via socket.sendMessage", () => {
      const socketHandler = new msrpSdk.SocketHandler(mockSocket);
      const message = { body: "test message", contentType: "text/plain" };
      const routePaths = ["msrp://192.168.1.100:2855/test-session-123;tcp"];
      const callback = jest.fn();

      // The SocketHandler adds sendMessage method to the socket
      expect(typeof mockSocket.sendMessage).toBe("function");

      // Mock the necessary components for sending
      const mockSender = {
        messageId: "test-msg-123",
        nextTid: "test-tid-123",
        getNextChunk: jest.fn().mockReturnValue({
          encode: jest.fn().mockReturnValue("MSRP test message"),
          fromPath: ["msrp://192.168.1.100:2855/test-session-123;tcp"],
        }),
        isSendComplete: jest.fn().mockReturnValue(true),
      };

      // Mock ChunkSender
      msrpSdk.ChunkSender = jest.fn().mockReturnValue(mockSender);

      mockSocket.sendMessage(mockSession, message, routePaths, callback);

      expect(msrpSdk.ChunkSender).toHaveBeenCalledWith(
        routePaths,
        message.body,
        message.contentType,
        null,
        null,
        undefined
      );
    });

    test("should handle socket destruction during message sending", () => {
      const socketHandler = new msrpSdk.SocketHandler(mockSocket);
      mockSocket.destroyed = true;

      const message = { body: "test message", contentType: "text/plain" };
      const routePaths = ["msrp://192.168.1.100:2855/test-session-123;tcp"];
      const callback = jest.fn();

      const errorSpy = jest.spyOn(msrpSdk.Logger, "error").mockImplementation();

      // Mock ChunkSender
      const mockSender = {
        messageId: "test-msg-123",
        nextTid: "test-tid-123",
        getNextChunk: jest.fn().mockReturnValue({
          encode: jest.fn().mockReturnValue("MSRP test message"),
        }),
        isSendComplete: jest.fn().mockReturnValue(true),
      };
      msrpSdk.ChunkSender = jest.fn().mockReturnValue(mockSender);

      mockSocket.sendMessage(mockSession, message, routePaths, callback);

      // Should log error for destroyed socket when trying to send
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Cannot send message. Socket unavailable.")
      );

      errorSpy.mockRestore();
    });
  });

  describe("Socket Events", () => {
    test("should handle socket timeout event", () => {
      const socketHandler = new msrpSdk.SocketHandler(mockSocket);

      const debugSpy = jest.spyOn(msrpSdk.Logger, "debug").mockImplementation();

      mockSocket.emit("timeout");

      // Should handle timeout gracefully
      expect(() => {
        mockSocket.emit("timeout");
      }).not.toThrow();

      debugSpy.mockRestore();
    });

    test("should handle socket error event", () => {
      const socketHandler = new msrpSdk.SocketHandler(mockSocket);
      const error = new Error("Connection refused");

      const errorSpy = jest.spyOn(msrpSdk.Logger, "error").mockImplementation();

      mockSocket.emit("error", error);

      // Should handle error gracefully
      expect(() => {
        mockSocket.emit("error", error);
      }).not.toThrow();

      errorSpy.mockRestore();
    });

    test("should handle socket close event", () => {
      const socketHandler = new msrpSdk.SocketHandler(mockSocket);

      const debugSpy = jest.spyOn(msrpSdk.Logger, "debug").mockImplementation();

      mockSocket.emit("close");

      // Should handle close gracefully
      expect(() => {
        mockSocket.emit("close");
      }).not.toThrow();

      debugSpy.mockRestore();
    });
  });

  describe("MSRP Tracing", () => {
    test("should trace MSRP messages when tracing is enabled", () => {
      msrpSdk.Config.traceMsrp = true;
      const debugSpy = jest.spyOn(msrpSdk.Logger, "debug").mockImplementation();

      const socketHandler = new msrpSdk.SocketHandler(mockSocket);
      const testMessage = "MSRP 12345678 SEND\r\n-------12345678$\r\n";

      mockSocket.emit("data", testMessage);

      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("MSRP trace:")
      );

      debugSpy.mockRestore();
    });

    test("should not trace MSRP messages when tracing is disabled", () => {
      msrpSdk.Config.traceMsrp = false;
      const debugSpy = jest.spyOn(msrpSdk.Logger, "debug").mockImplementation();

      const socketHandler = new msrpSdk.SocketHandler(mockSocket);
      const testMessage = "MSRP 12345678 SEND\r\n-------12345678$\r\n";

      mockSocket.emit("data", testMessage);

      // Should not contain tracing logs
      const traceCalls = debugSpy.mock.calls.filter(
        (call) => call[0] && call[0].includes("MSRP trace:")
      );
      expect(traceCalls.length).toBe(0);

      debugSpy.mockRestore();
    });
  });

  describe("Error Handling", () => {
    test("should handle destroyed socket in sendResponse", () => {
      const socketHandler = new msrpSdk.SocketHandler(mockSocket);
      mockSocket.destroyed = true;

      const mockRequest = {
        tid: "12345678",
        method: "SEND",
        toPath: ["msrp://192.168.1.100:2855/test-session-123;tcp"],
        fromPath: ["msrp://remote.example.com:2855/remote-session;tcp"],
      };

      const errorSpy = jest.spyOn(msrpSdk.Logger, "error").mockImplementation();

      // Mock OutgoingResponse
      msrpSdk.Message = msrpSdk.Message || {};
      msrpSdk.Message.OutgoingResponse = jest.fn().mockReturnValue({
        encode: jest.fn().mockReturnValue("MSRP response"),
      });

      // Trigger a request that would generate a response
      msrpSdk.parseMessage.mockReturnValue(mockRequest);
      msrpSdk.SessionController.getSession.mockReturnValue(null);

      const msrpMessage = "MSRP 12345678 SEND\r\n-------12345678$\r\n";
      mockSocket.emit("data", msrpMessage);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Unable to send message. Socket is destroyed.")
      );

      errorSpy.mockRestore();
    });

    test("should handle session setSocket error", () => {
      const mockParsedMessage = {
        tid: "12345678",
        method: "SEND",
        toPath: ["msrp://192.168.1.100:2855/test-session-123;tcp"],
        fromPath: ["msrp://remote.example.com:2855/remote-session;tcp"],
        messageId: "msg-123",
        byteRange: { start: 1, end: -1 },
        continuationFlag: "$",
      };

      msrpSdk.parseMessage.mockReturnValue(mockParsedMessage);
      mockSession.socket = null;
      mockSession.setSocket.mockImplementation(() => {
        throw new Error("Socket setup failed");
      });

      const errorSpy = jest.spyOn(msrpSdk.Logger, "error").mockImplementation();

      const socketHandler = new msrpSdk.SocketHandler(mockSocket);
      const msrpMessage = "MSRP 12345678 SEND\r\n-------12345678$\r\n";

      mockSocket.emit("data", msrpMessage);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Error setting socket for session")
      );

      errorSpy.mockRestore();
    });
  });

  describe("Configuration Options", () => {
    test("should respect useInboundMessageForSocketSetup configuration", () => {
      msrpSdk.Config.useInboundMessageForSocketSetup = false;

      const mockParsedMessage = {
        tid: "12345678",
        method: "SEND",
        toPath: ["msrp://192.168.1.100:2855/test-session-123;tcp"],
        fromPath: ["msrp://remote.example.com:2855/remote-session;tcp"],
        messageId: "msg-123",
      };

      msrpSdk.parseMessage.mockReturnValue(mockParsedMessage);
      mockSession.socket = null; // Session has no socket

      const debugSpy = jest.spyOn(msrpSdk.Logger, "debug").mockImplementation();
      const socketHandler = new msrpSdk.SocketHandler(mockSocket);
      const msrpMessage = "MSRP 12345678 SEND\r\n-------12345678$\r\n";

      mockSocket.emit("data", msrpMessage);

      expect(mockSession.setSocket).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("Buffering incoming request")
      );

      debugSpy.mockRestore();
    });
  });
});
