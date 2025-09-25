const MsrpSdkFactory = require("../../src/MsrpSdk.js");

describe("MSRP Core Functionality", () => {
  let msrpSdk;
  let cleanup = [];

  beforeEach(() => {
    cleanup = [];
  });

  afterEach(async () => {
    // Clean up any resources created during the test
    for (const cleanupFn of cleanup) {
      try {
        await cleanupFn();
      } catch (error) {
        console.warn("Cleanup error:", error.message);
      }
    }
    cleanup = [];
  });

  describe("Server Management", () => {
    test("should start and stop MSRP server on OS-assigned port", async () => {
      const config = {
        host: "127.0.0.1",
        port: 0, // OS-assigned port
        sessionName: "Server Test",
        acceptTypes: "text/plain",
        setup: "passive",
        traceMsrp: false,
      };

      msrpSdk = MsrpSdkFactory(config, {
        debug: () => {},
        info: () => {},
        warn: console.warn,
        error: console.error,
      });

      // Start server
      const startedPort = await new Promise((resolve, reject) => {
        msrpSdk.Server.start((error) => {
          if (error) {
            reject(error);
          } else {
            const actualPort = msrpSdk.Server.server.address().port;
            msrpSdk.Config.port = actualPort;
            resolve(actualPort);
          }
        });
      });

      expect(startedPort).toBeGreaterThan(0);
      expect(msrpSdk.Config.port).toBe(startedPort);
      expect(msrpSdk.Server.server.listening).toBe(true);

      // Stop server
      await new Promise((resolve) => {
        msrpSdk.Server.stop(() => resolve());
      });

      expect(msrpSdk.Server.server.listening).toBe(false);
    });

    test("should handle multiple start/stop cycles", async () => {
      const config = {
        host: "127.0.0.1",
        port: 0, // OS-assigned port
        sessionName: "Cycle Test",
        acceptTypes: "text/plain",
        setup: "passive",
        traceMsrp: false,
      };

      msrpSdk = MsrpSdkFactory(config, {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      });

      // Cycle 1
      await new Promise((resolve, reject) => {
        msrpSdk.Server.start((error) => {
          if (error) reject(error);
          else {
            msrpSdk.Config.port = msrpSdk.Server.server.address().port;
            resolve();
          }
        });
      });

      const port1 = msrpSdk.Config.port;
      expect(port1).toBeGreaterThan(0);

      await new Promise((resolve) => {
        msrpSdk.Server.stop(() => resolve());
      });

      // Cycle 2
      msrpSdk.Config.port = 0; // Reset to OS-assigned
      await new Promise((resolve, reject) => {
        msrpSdk.Server.start((error) => {
          if (error) reject(error);
          else {
            msrpSdk.Config.port = msrpSdk.Server.server.address().port;
            resolve();
          }
        });
      });

      const port2 = msrpSdk.Config.port;
      expect(port2).toBeGreaterThan(0);
      expect(port2).not.toBe(port1); // Should get a different port

      await new Promise((resolve) => {
        msrpSdk.Server.stop(() => resolve());
      });
    });
  });

  describe("Session Management", () => {
    beforeEach(async () => {
      const config = {
        host: "127.0.0.1",
        port: 0,
        sessionName: "Session Test",
        acceptTypes: "text/plain",
        setup: "passive",
        traceMsrp: false,
      };

      msrpSdk = MsrpSdkFactory(config, {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      });

      // Start server for session tests
      await new Promise((resolve, reject) => {
        msrpSdk.Server.start((error) => {
          if (error) reject(error);
          else {
            msrpSdk.Config.port = msrpSdk.Server.server.address().port;
            resolve();
          }
        });
      });

      // Add cleanup
      cleanup.push(async () => {
        return new Promise((resolve) => {
          msrpSdk.Server.stop(() => resolve());
        });
      });
    });

    test("should create and manage sessions", () => {
      // Create session
      const session1 = msrpSdk.SessionController.createSession();
      expect(session1).toBeDefined();
      expect(session1.sid).toBeDefined();
      expect(typeof session1.sid).toBe("string");

      // Create another session
      const session2 = msrpSdk.SessionController.createSession();
      expect(session2).toBeDefined();
      expect(session2.sid).not.toBe(session1.sid);

      // Remove sessions
      msrpSdk.SessionController.removeSession(session1);
      msrpSdk.SessionController.removeSession(session2);
    });

    test("should generate valid SDP", async () => {
      const session = msrpSdk.SessionController.createSession();

      const sdp = await new Promise((resolve, reject) => {
        session.getDescription(resolve, reject);
      });

      expect(sdp).toBeDefined();
      expect(typeof sdp).toBe("string");
      expect(sdp).toContain("v=0"); // SDP version
      expect(sdp).toContain("o="); // Origin
      expect(sdp).toContain("s="); // Session name
      expect(sdp).toContain("c=IN IP4 127.0.0.1"); // Connection
      expect(sdp).toContain("m=message"); // Media description
      expect(sdp).toContain("TCP/MSRP"); // Protocol
      expect(sdp).toContain("a=accept-types:text/plain"); // Accept types
      expect(sdp).toContain("a=setup:passive"); // Setup role
      expect(sdp).toContain(`a=path:msrp://127.0.0.1:${msrpSdk.Config.port}/`); // MSRP path

      msrpSdk.SessionController.removeSession(session);
    });

    test("should handle SDP offer/answer exchange", async () => {
      // Create two sessions to simulate offer/answer exchange
      const offerSession = msrpSdk.SessionController.createSession();
      const answerSession = msrpSdk.SessionController.createSession();

      // Generate offer
      const offer = await new Promise((resolve, reject) => {
        offerSession.getDescription(resolve, reject);
      });

      expect(offer).toContain("m=message");

      // Process offer and generate answer
      await new Promise((resolve, reject) => {
        answerSession.setDescription(offer, resolve, reject);
      });

      const answer = await new Promise((resolve, reject) => {
        answerSession.getDescription(resolve, reject);
      });

      expect(answer).toContain("m=message");
      expect(answer).toContain("a=setup:active"); // Should switch to active

      // Process answer
      await new Promise((resolve, reject) => {
        offerSession.setDescription(answer, resolve, reject);
      });

      // Clean up
      msrpSdk.SessionController.removeSession(offerSession);
      msrpSdk.SessionController.removeSession(answerSession);
    });
  });

  describe("Message Creation", () => {
    beforeEach(async () => {
      const config = {
        host: "127.0.0.1",
        port: 0,
        sessionName: "Message Test",
        acceptTypes: "text/plain",
        setup: "passive",
        traceMsrp: false,
      };

      msrpSdk = MsrpSdkFactory(config, {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      });

      await new Promise((resolve, reject) => {
        msrpSdk.Server.start((error) => {
          if (error) reject(error);
          else {
            msrpSdk.Config.port = msrpSdk.Server.server.address().port;
            resolve();
          }
        });
      });

      cleanup.push(async () => {
        return new Promise((resolve) => {
          msrpSdk.Server.stop(() => resolve());
        });
      });
    });

    test("should create OutgoingRequest messages", () => {
      const session = msrpSdk.SessionController.createSession();

      // Create an outgoing MSRP message using the SDK's Message API
      const message = new msrpSdk.Message.OutgoingRequest(session, "SEND");

      expect(message).toBeDefined();
      expect(message.method).toBe("SEND");
      expect(message.session).toBe(session);
      expect(typeof message.encode).toBe("function");

      // Initialize required paths for encoding
      message.addHeader(
        "To-Path",
        `msrp://127.0.0.1:${msrpSdk.Config.port}/session123;tcp`
      );
      message.addHeader(
        "From-Path",
        `msrp://127.0.0.1:${msrpSdk.Config.port}/session456;tcp`
      );

      // Test message encoding
      const encodedMessage = message.encode();
      expect(typeof encodedMessage).toBe("string");
      expect(encodedMessage).toContain("MSRP");
      expect(encodedMessage).toContain("SEND");
      expect(encodedMessage).toContain("To-Path:");
      expect(encodedMessage).toContain("From-Path:");

      msrpSdk.SessionController.removeSession(session);
    });

    test("should handle message content types", () => {
      const session = msrpSdk.SessionController.createSession();

      // Create message with content type
      const message = new msrpSdk.Message.OutgoingRequest(session, "SEND");
      message.addHeader("Content-Type", "text/plain");

      expect(message.contentType).toBe("text/plain");

      // Test JSON content type
      message.addHeader("Content-Type", "application/json");
      expect(message.contentType).toBe("application/json");

      msrpSdk.SessionController.removeSession(session);
    });

    test("should validate sendMessage method exists", () => {
      const session = msrpSdk.SessionController.createSession();

      // Verify the session has sendMessage method
      expect(typeof session.sendMessage).toBe("function");

      // Test that sendMessage fails gracefully for unconnected session
      const messageContent = "Test message";
      const contentType = "text/plain";

      expect(() => {
        session.sendMessage(messageContent, null, contentType);
      }).toThrow(); // Should throw because session isn't properly set up

      msrpSdk.SessionController.removeSession(session);
    });
  });
});
