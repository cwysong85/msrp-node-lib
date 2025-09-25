const MsrpSdkFactory = require("../../src/MsrpSdk.js");

describe("Direct MSRP SDK Test", () => {
  let msrpSdk;

  beforeEach(() => {
    // Create MSRP SDK instance
    const config = {
      host: "127.0.0.1",
      port: 0, // OS-assigned port
      sessionName: "Direct Test Session",
      acceptTypes: "text/plain",
      setup: "passive",
      traceMsrp: false,
    };

    msrpSdk = MsrpSdkFactory(config, console);
  });

  test("should create MSRP SDK instance", () => {
    expect(msrpSdk).toBeDefined();
    expect(msrpSdk.Config).toBeDefined();
    expect(msrpSdk.Config.host).toBe("127.0.0.1");
    expect(msrpSdk.Config.port).toBe(0);
  });

  test("should have Server instance", () => {
    expect(msrpSdk.Server).toBeDefined();
    expect(typeof msrpSdk.Server.start).toBe("function");
    expect(typeof msrpSdk.Server.stop).toBe("function");
  });

  test("should create session", () => {
    const session = msrpSdk.SessionController.createSession();
    expect(session).toBeDefined();
    expect(session.sid).toBeDefined();
  });

  test("should start and stop server", async () => {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Server start timeout"));
      }, 5000);

      msrpSdk.Server.start((error) => {
        clearTimeout(timeout);
        if (error) {
          reject(error);
        } else {
          const actualPort = msrpSdk.Server.server.address().port;
          expect(actualPort).toBeGreaterThan(0);

          // Stop the server
          msrpSdk.Server.stop(() => {
            resolve();
          });
        }
      });
    });
  });
});
