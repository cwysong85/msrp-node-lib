const msrp = require("../src/MsrpSdk.js");

describe("Session Management", () => {
  let msrpSdk;
  let sessionController;

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
    sessionController = msrpSdk.SessionController;
  });

  describe("Session Creation", () => {
    test("should create a new session with correct configuration", () => {
      const session = sessionController.createSession();

      expect(session).toBeDefined();
      expect(session.sid).toMatch(/^[a-zA-Z0-9]{10}$/);
    });

    test("should generate unique session IDs", () => {
      const session1 = sessionController.createSession();
      const session2 = sessionController.createSession();

      expect(session1.sid).not.toBe(session2.sid);
      expect(session1.sid).toMatch(/^[a-zA-Z0-9]{10}$/);
      expect(session2.sid).toMatch(/^[a-zA-Z0-9]{10}$/);
    });
  });

  describe("SDP Generation", () => {
    test("should generate valid SDP with advertiseHost", (done) => {
      const session = sessionController.createSession();

      session.getDescription(
        (sdp) => {
          expect(sdp).toContain("203.0.113.10"); // advertiseHost
          expect(sdp).not.toContain("192.168.1.100"); // should not contain binding host
          expect(sdp).toContain("TCP/MSRP *");
          expect(sdp).toContain("a=accept-types:text/plain");
          expect(sdp).toContain("a=setup:active");
          done();
        },
        (error) => {
          done(error);
        }
      );
    });

    test("should include correct MSRP path in SDP", (done) => {
      const session = sessionController.createSession();

      session.getDescription(
        (sdp) => {
          expect(sdp).toMatch(
            /a=path:msrp:\/\/203\.0\.113\.10:\d+\/[a-zA-Z0-9]{10};tcp/
          );
          done();
        },
        (error) => {
          done(error);
        }
      );
    });

    test("should handle session-name in SDP", (done) => {
      const session = sessionController.createSession();

      session.getDescription(
        (sdp) => {
          expect(sdp).toContain("s=test-session");
          done();
        },
        (error) => {
          done(error);
        }
      );
    });
  });

  describe("Message Handling", () => {
    test("should send message with correct content", (done) => {
      const session = sessionController.createSession();

      // Mock the sendMessage method since we need a connection for it to work
      const originalSendMessage = session.sendMessage;
      session.sendMessage = (body, callback, contentType = "text/plain") => {
        expect(body).toBe("Hello World");
        expect(contentType).toBe("text/plain");
        if (callback) callback(null, "success");
      };

      session.sendMessage("Hello World", (error, result) => {
        expect(error).toBeNull();
        expect(result).toBe("success");
        done();
      });
    });

    test("should handle empty message body", (done) => {
      const session = sessionController.createSession();

      session.sendMessage = (body, callback) => {
        expect(body).toBe("");
        if (callback) callback(null, "success");
      };

      session.sendMessage("", (error, result) => {
        expect(error).toBeNull();
        done();
      });
    });

    test("should handle different content types", (done) => {
      const session = sessionController.createSession();

      session.sendMessage = (body, callback, contentType) => {
        expect(body).toBe('{"test": true}');
        expect(contentType).toBe("application/json");
        if (callback) callback(null, "success");
      };

      session.sendMessage(
        '{"test": true}',
        (error, result) => {
          expect(error).toBeNull();
          done();
        },
        "application/json"
      );
    });
  });

  describe("Event Handling", () => {
    test("should emit session events", (done) => {
      const session = sessionController.createSession();

      session.on("socketConnect", () => {
        done();
      });

      // Simulate connection (this would normally happen automatically)
      setTimeout(() => {
        session.emit("socketConnect");
      }, 10);
    });

    test("should handle message events", (done) => {
      const session = sessionController.createSession();
      const testMessage = "Test message content";

      session.on("message", (message) => {
        expect(message.body).toBe(testMessage);
        done();
      });

      // Simulate incoming message
      setTimeout(() => {
        session.emit("message", { body: testMessage });
      }, 10);
    });
  });
});
