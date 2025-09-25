const MsrpSdkFactory = require("../../src/MsrpSdk.js");

describe("Simple MSRP Session Functionality", () => {
  let msrpSdk;

  beforeEach(() => {
    // Create MSRP SDK instance directly (like the working direct test)
    const config = {
      host: "127.0.0.1",
      port: 0, // OS-assigned port
      sessionName: "Simple Test Session",
      acceptTypes: "text/plain",
      setup: "passive",
      traceMsrp: false,
    };

    msrpSdk = MsrpSdkFactory(config, {
      debug: (...args) => console.debug("[simple-test]", ...args),
      info: (...args) => console.info("[simple-test]", ...args),
      warn: (...args) => console.warn("[simple-test]", ...args),
      error: (...args) => console.error("[simple-test]", ...args),
    });
  });

  test("should start and stop MSRP server successfully", async () => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Server start timeout"));
      }, 5000);

      msrpSdk.Server.start((error) => {
        if (error) {
          clearTimeout(timeout);
          reject(error);
        } else {
          const actualPort = msrpSdk.Server.server.address().port;
          expect(actualPort).toBeGreaterThan(0);

          // Stop the server
          msrpSdk.Server.stop(() => {
            clearTimeout(timeout);
            resolve();
          });
        }
      });
    });
  });

  test("should create and manage sessions", () => {
    // Create a session
    const session = msrpSdk.SessionController.createSession();

    expect(session).toBeDefined();
    expect(session.sid).toBeDefined();

    // Remove the session
    msrpSdk.SessionController.removeSession(session);
  });

  test("should generate SDP for session", async () => {
    // Start server first and update config with actual port
    await new Promise((resolve, reject) => {
      msrpSdk.Server.start((error) => {
        if (error) {
          reject(error);
        } else {
          // Update the config with the actual assigned port
          const actualPort = msrpSdk.Server.server.address().port;
          msrpSdk.Config.port = actualPort;
          resolve();
        }
      });
    });

    try {
      // Create a session (after port is updated)
      const session = msrpSdk.SessionController.createSession();

      // Generate SDP
      const sdp = await new Promise((resolve, reject) => {
        session.getDescription(resolve, reject);
      });

      expect(sdp).toBeDefined();
      expect(typeof sdp).toBe("string");
      expect(sdp).toContain("m=message");
      expect(sdp).toContain("TCP/MSRP");

      const actualPort = msrpSdk.Config.port;
      expect(sdp).toContain(actualPort.toString());
    } finally {
      // Stop server
      await new Promise((resolve) => {
        msrpSdk.Server.stop(() => resolve());
      });
    }
  });
});
