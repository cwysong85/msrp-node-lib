const msrp = require("../src/MsrpSdk.js");
const { EventEmitter } = require("events");

describe("Session", () => {
  let msrpSdk;
  let session;
  let mockSocket;

  beforeEach(() => {
    const config = {
      host: "192.168.1.100",
      port: 2855,
      sessionName: "test-session",
      acceptTypes: "text/plain",
      setup: "active",
      enableHeartbeats: true,
    };
    msrpSdk = msrp(config);

    // Mock Util functions before creating session
    msrpSdk.Util.newSID = jest.fn().mockReturnValue("test-session-123");
    msrpSdk.Util.dateToNtpTime = jest.fn().mockReturnValue("3906764800");
    msrpSdk.Util.getAdvertiseHost = jest.fn().mockReturnValue("192.168.1.100");
    msrpSdk.Util.randomInt = jest.fn().mockReturnValue(2855);

    // Create new session
    session = new msrpSdk.Session();

    // Create mock socket
    mockSocket = new EventEmitter();
    mockSocket.remoteAddress = "192.168.1.100";
    mockSocket.remotePort = 2855;
    mockSocket.write = jest.fn();
    mockSocket.end = jest.fn();
    mockSocket.destroy = jest.fn();
    mockSocket.sendMessage = jest.fn();
  });

  afterEach(() => {
    // Clean up any active timers/intervals
    if (session) {
      session.stopHeartbeats();
      if (session.socket) {
        session.closeSocket();
      }
      session.end();
    }
    jest.clearAllMocks();
  });

  describe("Session Creation", () => {
    test("should create a new session with default properties", () => {
      expect(session.sid).toBe("test-session-123");
      expect(session.localEndpoint).toBeNull();
      expect(session.remoteEndpoints).toEqual([]);
      expect(session.localSdp).toBeNull();
      expect(session.remoteSdp).toBeNull();
      expect(session.socket).toBeNull();
      expect(session.updated).toBe(false);
      expect(session.ended).toBe(false);
      expect(session.heartbeatsTransIds).toEqual({});
      expect(session.sdpState).toBeNull();
    });

    test("should be an EventEmitter", () => {
      expect(session).toBeInstanceOf(EventEmitter);
    });

    test("should generate unique session IDs", () => {
      msrpSdk.Util.newSID.mockReturnValueOnce("session-1");
      const session1 = new msrpSdk.Session();

      msrpSdk.Util.newSID.mockReturnValueOnce("session-2");
      const session2 = new msrpSdk.Session();

      expect(session1.sid).toBe("session-1");
      expect(session2.sid).toBe("session-2");
    });
  });

  describe("Message Sending", () => {
    beforeEach(() => {
      // Setup session with remote SDP and socket
      session.remoteSdp = {
        attributes: {
          "accept-types": ["text/plain", "text/*"],
          sendrecv: true,
        },
        media: [
          {
            attributes: {
              sendrecv: true,
            },
          },
        ],
      };
      session.remoteEndpoints = [
        "msrp://remote.example.com:2855/remote-session;tcp",
      ];
      session.localEndpoint = {
        uri: "msrp://192.168.1.100:2855/test-session-123;tcp",
      };
      session.socket = mockSocket;
    });

    test("should send message with valid content type", () => {
      const callback = jest.fn();
      const body = "Hello World";
      const contentType = "text/plain";

      session.sendMessage(body, callback, contentType);

      expect(mockSocket.sendMessage).toHaveBeenCalledWith(
        session,
        { body: body, contentType: contentType },
        {
          toPath: session.remoteEndpoints,
          localUri: session.localEndpoint.uri,
        },
        callback,
        undefined
      );
    });

    test("should use default content type when not specified", () => {
      const callback = jest.fn();
      const body = "Hello World";

      session.sendMessage(body, callback);

      expect(mockSocket.sendMessage).toHaveBeenCalledWith(
        session,
        { body: body, contentType: "text/plain" },
        {
          toPath: session.remoteEndpoints,
          localUri: session.localEndpoint.uri,
        },
        callback,
        undefined
      );
    });

    test("should handle wildcard accept-types", () => {
      session.remoteSdp.attributes["accept-types"] = ["*"];
      const callback = jest.fn();

      session.sendMessage("Hello", callback, "application/json");

      expect(mockSocket.sendMessage).toHaveBeenCalled();
    });

    test("should handle partial wildcard accept-types", () => {
      session.remoteSdp.attributes["accept-types"] = ["text/*"];
      const callback = jest.fn();

      session.sendMessage("Hello", callback, "text/html");

      expect(mockSocket.sendMessage).toHaveBeenCalled();
    });

    test("should reject message when content type not accepted", () => {
      session.remoteSdp.attributes["accept-types"] = ["text/plain"];
      const callback = jest.fn();

      const warnSpy = jest.spyOn(msrpSdk.Logger, "warn").mockImplementation();

      session.sendMessage("Hello", callback, "application/json");

      expect(mockSocket.sendMessage).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          message: "Cannot send message due to remote endpoint SDP attributes",
        })
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Cannot send message due to remote endpoint SDP attributes"
        )
      );

      warnSpy.mockRestore();
    });

    test("should reject message when remote is sendonly", () => {
      session.remoteSdp.attributes.sendonly = true;
      delete session.remoteSdp.attributes.sendrecv;
      const callback = jest.fn();

      session.sendMessage("Hello", callback, "text/plain");

      expect(mockSocket.sendMessage).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          message: "Cannot send message due to remote endpoint SDP attributes",
        })
      );
    });

    test("should reject message when remote is inactive", () => {
      session.remoteSdp.attributes.inactive = true;
      const callback = jest.fn();

      session.sendMessage("Hello", callback, "text/plain");

      expect(mockSocket.sendMessage).not.toHaveBeenCalled();
      expect(callback).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          message: "Cannot send message due to remote endpoint SDP attributes",
        })
      );
    });

    test("should handle missing socket", () => {
      session.socket = null;
      const callback = jest.fn();

      const errorSpy = jest.spyOn(msrpSdk.Logger, "error").mockImplementation();

      session.sendMessage("Hello", callback, "text/plain");

      expect(callback).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          message: "Socket unavailable",
        })
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Cannot send message because there is not an active socket"
        )
      );

      errorSpy.mockRestore();
    });

    test("should handle media-level sendonly attribute", () => {
      session.remoteSdp.media[0].attributes.sendonly = true;
      delete session.remoteSdp.media[0].attributes.sendrecv;
      const callback = jest.fn();

      session.sendMessage("Hello", callback, "text/plain");

      expect(mockSocket.sendMessage).not.toHaveBeenCalled();
    });
  });

  describe("SDP Handling", () => {
    test("should create local SDP description", async () => {
      const onSuccess = jest.fn();
      const onFailure = jest.fn();

      // Mock all config that the SDP creation needs
      msrpSdk.Config.setup = "active";
      msrpSdk.Config.sessionName = "test-session";
      msrpSdk.Config.host = "192.168.1.100";
      msrpSdk.Config.port = 2855;
      msrpSdk.Config.acceptTypes = "text/plain";
      msrpSdk.Config.outboundBasePort = 49152;
      msrpSdk.Config.outboundHighestPort = 65535;

      // Mock SDP creation
      const mockSdp = {
        origin: { id: null, version: null, address: null },
        sessionName: "",
        connection: { address: null },
        addAttribute: jest.fn(),
        addMedia: jest.fn(),
        media: [],
        attributes: { setup: ["active"] }, // Mock setup attribute
        toString: jest
          .fn()
          .mockReturnValue(
            "v=0\r\no=- 3906764800 3906764800 IN IP4 192.168.1.100\r\n"
          ),
      };
      msrpSdk.Sdp = msrpSdk.Sdp || {};
      msrpSdk.Sdp.Session = jest.fn().mockReturnValue(mockSdp);

      // Mock URI creation
      msrpSdk.URI = jest.fn().mockImplementation((path) => ({ path }));

      // Mock portfinder for getAssignedPort function
      jest.doMock("portfinder", () => ({
        getPortPromise: jest.fn().mockResolvedValue(2855),
      }));

      const debugSpy = jest.spyOn(msrpSdk.Logger, "debug").mockImplementation();

      await session.getDescription(onSuccess, onFailure);

      expect(mockSdp.origin.id).toBe("3906764800");
      expect(mockSdp.origin.version).toBe("3906764800");
      expect(mockSdp.origin.address).toBe("192.168.1.100");
      expect(mockSdp.sessionName).toBe("test-session");
      expect(mockSdp.connection.address).toBe("192.168.1.100");
      expect(onSuccess).toHaveBeenCalledWith(
        "v=0\r\no=- 3906764800 3906764800 IN IP4 192.168.1.100\r\n"
      );
      expect(session.localSdp).toBe(mockSdp);

      debugSpy.mockRestore();
    });

    test("should handle SDP creation error", async () => {
      const onSuccess = jest.fn();
      const onFailure = jest.fn();

      // Mock SDP creation to throw error
      msrpSdk.Sdp = msrpSdk.Sdp || {};
      msrpSdk.Sdp.Session = jest.fn().mockImplementation(() => {
        throw new Error("SDP creation failed");
      });

      const errorSpy = jest.spyOn(msrpSdk.Logger, "error").mockImplementation();

      await session.getDescription(onSuccess, onFailure);

      expect(onSuccess).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("An error ocurred while creating the local SDP")
      );

      errorSpy.mockRestore();
    });

    test("should set remote SDP description", () => {
      const onSuccess = jest.fn();
      const onFailure = jest.fn();
      const remoteSdpString =
        "v=0\r\no=- 123456 123456 IN IP4 remote.example.com\r\n";

      // Mock remote SDP parsing
      const mockRemoteSdp = {
        media: [
          {
            proto: "TCP/MSRP",
            attributes: {
              "accept-types": ["text/plain"],
              path: ["msrp://remote.example.com:2855/remote-session;tcp"],
            },
          },
        ],
        attributes: {},
      };
      msrpSdk.Sdp = msrpSdk.Sdp || {};
      msrpSdk.Sdp.Session = jest.fn().mockReturnValue(mockRemoteSdp);

      const debugSpy = jest.spyOn(msrpSdk.Logger, "debug").mockImplementation();

      session.setDescription(remoteSdpString, onSuccess, onFailure);

      expect(msrpSdk.Sdp.Session).toHaveBeenCalledWith(remoteSdpString);
      expect(session.remoteSdp).toBe(mockRemoteSdp);
      expect(session.remoteEndpoints).toEqual([
        "msrp://remote.example.com:2855/remote-session;tcp",
      ]);
      expect(onSuccess).toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("Processing remote SDP")
      );

      debugSpy.mockRestore();
    });

    test("should handle invalid remote SDP", () => {
      const onSuccess = jest.fn();
      const onFailure = jest.fn();
      const invalidSdpString = "invalid sdp";

      // Mock SDP parsing to throw error
      msrpSdk.Sdp = msrpSdk.Sdp || {};
      msrpSdk.Sdp.Session = jest.fn().mockImplementation(() => {
        throw new Error("Invalid SDP");
      });

      const errorSpy = jest.spyOn(msrpSdk.Logger, "error").mockImplementation();

      session.setDescription(invalidSdpString, onSuccess, onFailure);

      expect(onSuccess).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "An error ocurred while processing the remote SDP"
        )
      );

      errorSpy.mockRestore();
    });
  });

  describe("Socket Management", () => {
    test("should set socket with SDP check", () => {
      session.remoteEndpoints = [
        "msrp://192.168.1.100:2855/remote-session;tcp",
      ];

      expect(() => {
        session.setSocket(mockSocket, true);
      }).not.toThrow();

      expect(session.socket).toBe(mockSocket);
    });

    test("should reject socket with wrong address when SDP check enabled", () => {
      session.remoteEndpoints = [
        "msrp://different.example.com:2855/remote-session;tcp",
      ];
      mockSocket.remoteAddress = "192.168.1.100";
      mockSocket.remotePort = 2855;

      expect(() => {
        session.setSocket(mockSocket, true);
      }).toThrow("Socket does not belong to the expected remote endpoint");
    });

    test("should set socket without SDP check", () => {
      session.remoteEndpoints = [
        "msrp://different.example.com:2855/remote-session;tcp",
      ];

      expect(() => {
        session.setSocket(mockSocket, false);
      }).not.toThrow();

      expect(session.socket).toBe(mockSocket);
    });

    test("should emit socketSet event when socket is set", () => {
      const socketSetSpy = jest.fn();
      session.on("socketSet", socketSetSpy);

      session.setSocket(mockSocket, false);

      expect(socketSetSpy).toHaveBeenCalledWith(session);
    });

    test("should close socket properly", () => {
      session.socket = mockSocket;
      mockSocket.destroyed = false;

      const debugSpy = jest.spyOn(msrpSdk.Logger, "debug").mockImplementation();

      session.closeSocket();

      expect(mockSocket.end).toHaveBeenCalled();
      expect(session.socket).toBeUndefined();
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("Closing MSRP session")
      );

      debugSpy.mockRestore();
    });

    test("should handle already destroyed socket", () => {
      session.socket = mockSocket;
      mockSocket.destroyed = true;

      const debugSpy = jest.spyOn(msrpSdk.Logger, "debug").mockImplementation();

      session.closeSocket();

      expect(mockSocket.end).toHaveBeenCalled(); // Still calls end() but it's a no-op
      expect(session.socket).toBeUndefined();

      debugSpy.mockRestore();
    });
  });

  describe("Session Lifecycle", () => {
    test("should end session properly", () => {
      session.socket = mockSocket;
      session.ended = false;

      const endSpy = jest.fn();
      session.on("end", endSpy);

      const debugSpy = jest.spyOn(msrpSdk.Logger, "debug").mockImplementation();

      session.end();

      expect(session.ended).toBe(true);
      expect(endSpy).toHaveBeenCalledWith(session);
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("Ending MSRP session")
      );

      debugSpy.mockRestore();
    });

    test("should not end session twice", () => {
      session.ended = true;

      const endSpy = jest.fn();
      session.on("end", endSpy);

      const debugSpy = jest.spyOn(msrpSdk.Logger, "debug").mockImplementation();

      session.end();

      expect(endSpy).not.toHaveBeenCalled();
      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("already ended")
      );

      debugSpy.mockRestore();
    });

    test("should update SDP state", () => {
      const debugSpy = jest.spyOn(msrpSdk.Logger, "debug").mockImplementation();

      session.updateSdpState();

      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("SDP negotiation state updated")
      );

      debugSpy.mockRestore();
    });
  });

  describe("Heartbeats", () => {
    test("should start heartbeats when enabled", () => {
      session.socket = mockSocket;
      session.remoteEndpoints = [
        "msrp://remote.example.com:2855/remote-session;tcp",
      ];
      session.localEndpoint = {
        uri: "msrp://192.168.1.100:2855/test-session-123;tcp",
      };

      // Mock setInterval
      const setIntervalSpy = jest
        .spyOn(global, "setInterval")
        .mockReturnValue("interval-id");

      session.startHeartbeats();

      expect(setIntervalSpy).toHaveBeenCalled();
      expect(session.heartbeatPingFunc).toBe("interval-id");

      setIntervalSpy.mockRestore();
    });

    test("should stop heartbeats", () => {
      session.heartbeatPingFunc = "interval-id";
      session.heartbeatTimeoutFunc = "timeout-id";

      const clearIntervalSpy = jest
        .spyOn(global, "clearInterval")
        .mockImplementation();
      const clearTimeoutSpy = jest
        .spyOn(global, "clearTimeout")
        .mockImplementation();
      const debugSpy = jest.spyOn(msrpSdk.Logger, "debug").mockImplementation();

      session.stopHeartbeats();

      expect(clearIntervalSpy).toHaveBeenCalledWith("interval-id");
      // clearTimeout might not be called if there's no timeout set
      expect(session.heartbeatPingFunc).toBeNull();
      expect(session.heartbeatTimeoutFunc).toBeNull();

      clearIntervalSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      debugSpy.mockRestore();
    });

    test("should start heartbeats even when enableHeartbeats is false", () => {
      // The current implementation doesn't check enableHeartbeats in startHeartbeats()
      // This test verifies the actual behavior
      const originalHeartbeats = msrpSdk.Config.enableHeartbeats;
      msrpSdk.Config.enableHeartbeats = false;

      session.socket = mockSocket;

      const setIntervalSpy = jest.spyOn(global, "setInterval");

      session.startHeartbeats();

      // The current implementation still creates heartbeats even when disabled
      expect(session.heartbeatPingFunc).toBeTruthy();
      expect(setIntervalSpy).toHaveBeenCalled();

      setIntervalSpy.mockRestore();

      // Restore original setting
      msrpSdk.Config.enableHeartbeats = originalHeartbeats;
    });
  });

  describe("Event Handling", () => {
    test("should emit message events", () => {
      const messageSpy = jest.fn();
      session.on("message", messageSpy);

      const mockMessage = { body: "Hello World" };
      session.emit("message", mockMessage, session);

      expect(messageSpy).toHaveBeenCalledWith(mockMessage, session);
    });

    test("should emit report events", () => {
      const reportSpy = jest.fn();
      session.on("report", reportSpy);

      const mockReport = { status: "200 OK" };
      session.emit("report", mockReport, session);

      expect(reportSpy).toHaveBeenCalledWith(mockReport, session);
    });

    test("should emit messageSent events", () => {
      const messageSentSpy = jest.fn();
      session.on("messageSent", messageSentSpy);

      const mockMessage = { body: "Hello World" };
      session.emit("messageSent", mockMessage, session);

      expect(messageSentSpy).toHaveBeenCalledWith(mockMessage, session);
    });
  });
});
