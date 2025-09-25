const msrp = require("../../../src/MsrpSdk.js");
const EventEmitter = require("events");
const net = require("net");

// Utility function to check if port is actually free
function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, host, () => {
      server.once("close", () => resolve(true));
      server.close();
    });
    server.on("error", () => resolve(false));
  });
}

class TestInstance extends EventEmitter {
  constructor(config, name = "test-instance") {
    super();
    this.name = name;
    this.config = {
      sessionName: name,
      acceptTypes: "text/plain",
      traceMsrp: process.env.DEBUG_MSRP === "true",
      enableHeartbeats: false, // Disable for testing unless specifically needed
      // Ensure unique configuration
      danglingSocketTimeout: 1000, // Shorter timeout for tests
      ...config,
    };

    // Use OS-assigned port (0) to avoid conflicts entirely
    this.config.port = 0;

    // Create isolated MSRP SDK instance with unique configuration
    this.msrp = msrp(this.config, this.createLogger());
    this.server = this.msrp.Server;
    this.sessions = [];
    this.isStarted = false;
    this.actualPort = null;
  }

  createLogger() {
    const prefix = `[${this.name}]`;
    return {
      debug: (...args) => console.debug(prefix, ...args),
      info: (...args) => console.info(prefix, ...args),
      warn: (...args) => console.warn(prefix, ...args),
      error: (...args) => console.error(prefix, ...args),
    };
  }

  async start() {
    if (this.isStarted) return;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Failed to start ${this.name} within timeout`));
      }, 5000);

      this.server.start((error) => {
        clearTimeout(timeout);
        if (error) {
          this.debug(`Failed to start: ${error.message}`);
          reject(error);
        } else {
          // Get the actual assigned port
          this.actualPort = this.server.server.address().port;
          this.config.port = this.actualPort; // Update config with actual port
          this.isStarted = true;
          this.debug(`Started successfully on port ${this.actualPort}`);
          resolve();
        }
      });
    });
  }

  async stop() {
    if (!this.isStarted) return;

    // Clean up all sessions first
    for (const session of this.sessions) {
      try {
        // End the session to close sockets
        if (session && !session.ended) {
          session.end();
        }
        this.msrp.SessionController.removeSession(session);
      } catch (error) {
        console.warn(`Error removing session: ${error.message}`);
      }
    }
    this.sessions = [];

    // Stop server using the SDK's stop method (like the successful direct test)
    return new Promise((resolve) => {
      if (this.isStarted) {
        this.server.stop(() => {
          this.isStarted = false;
          this.actualPort = null;
          this.debug(`Stopped successfully`);
          resolve();
        });

        // Timeout fallback
        setTimeout(() => {
          if (this.isStarted) {
            console.warn(`[${this.name}] Force closing server after timeout`);
            this.isStarted = false;
            this.actualPort = null;
            resolve();
          }
        }, 1000);
      } else {
        resolve();
      }
    });
  }

  createSession() {
    const session = this.msrp.SessionController.createSession();
    this.sessions.push(session);
    return session;
  }

  removeSession(session) {
    const index = this.sessions.indexOf(session);
    if (index > -1) {
      this.sessions.splice(index, 1);
    }
    this.msrp.SessionController.removeSession(session);
  }
}

class SDPNegotiator {
  constructor(localInstance, remoteInstance) {
    this.local = localInstance;
    this.remote = remoteInstance;
  }

  async negotiate(localSession, remoteSession) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("SDP negotiation timeout"));
      }, 15000);

      let localSdpComplete = false;
      let remoteSdpComplete = false;

      const checkComplete = () => {
        if (localSdpComplete && remoteSdpComplete) {
          clearTimeout(timeout);
          resolve({
            localSession,
            remoteSession,
            localSdp: localSession.localSdp,
            remoteSdp: remoteSession.remoteSdp,
          });
        }
      };

      // Generate local SDP for local session
      localSession.getDescription(
        (localSdp) => {
          // Set remote SDP on remote session
          remoteSession.setDescription(
            localSdp,
            () => {
              localSdpComplete = true;

              // Generate local SDP for remote session (SDP answer)
              remoteSession.getDescription(
                (remoteSdp) => {
                  // Set remote SDP on local session
                  localSession.setDescription(
                    remoteSdp,
                    () => {
                      remoteSdpComplete = true;
                      checkComplete();
                    },
                    (error) => {
                      clearTimeout(timeout);
                      reject(
                        new Error(
                          `Local session setDescription failed: ${error}`
                        )
                      );
                    }
                  );
                },
                (error) => {
                  clearTimeout(timeout);
                  reject(
                    new Error(`Remote session getDescription failed: ${error}`)
                  );
                }
              );
            },
            (error) => {
              clearTimeout(timeout);
              reject(
                new Error(`Remote session setDescription failed: ${error}`)
              );
            }
          );
        },
        (error) => {
          clearTimeout(timeout);
          reject(new Error(`Local session getDescription failed: ${error}`));
        }
      );
    });
  }
}

class MessageExchanger {
  constructor() {
    this.messageQueue = [];
    this.waitingPromises = [];
  }

  setupSession(session, name) {
    session.on("message", (message, session, encodedMessage) => {
      const messageData = {
        session,
        message,
        encodedMessage,
        receivedAt: Date.now(),
        receivedBy: name,
      };

      this.messageQueue.push(messageData);

      // Resolve any waiting promises
      if (this.waitingPromises.length > 0) {
        const resolve = this.waitingPromises.shift();
        resolve(messageData);
      }
    });

    session.on("messageSent", (message, session, encodedMessage) => {
      // Optional: track sent messages
    });

    session.on("report", (report, session, encodedReport) => {
      // Optional: track delivery reports
    });
  }

  async waitForMessage(timeoutMs = 10000) {
    if (this.messageQueue.length > 0) {
      return this.messageQueue.shift();
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waitingPromises.indexOf(resolve);
        if (index > -1) {
          this.waitingPromises.splice(index, 1);
        }
        reject(new Error("Message wait timeout"));
      }, timeoutMs);

      const wrappedResolve = (messageData) => {
        clearTimeout(timeout);
        resolve(messageData);
      };

      this.waitingPromises.push(wrappedResolve);
    });
  }

  async sendMessage(session, body, contentType = "text/plain") {
    return new Promise((resolve, reject) => {
      session.sendMessage(
        body,
        (error) => {
          if (error) {
            reject(new Error(`Failed to send message: ${error.message}`));
          } else {
            resolve();
          }
        },
        contentType
      );
    });
  }

  getReceivedMessages() {
    return [...this.messageQueue];
  }

  clear() {
    this.messageQueue = [];
    // Reject any waiting promises
    while (this.waitingPromises.length > 0) {
      const reject = this.waitingPromises.shift();
      reject(new Error("Message exchanger cleared"));
    }
  }
}

class ConnectionWaiter {
  static async waitForConnection(session, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Connection timeout"));
      }, timeoutMs);

      const onSocketSet = () => {
        clearTimeout(timeout);
        session.removeListener("socketSet", onSocketSet);
        resolve(session);
      };

      // Check if already connected
      if (session.socket && !session.socket.destroyed) {
        clearTimeout(timeout);
        resolve(session);
        return;
      }

      session.on("socketSet", onSocketSet);
    });
  }

  static async waitForBothConnections(session1, session2, timeoutMs = 15000) {
    const [conn1, conn2] = await Promise.all([
      this.waitForConnection(session1, timeoutMs),
      this.waitForConnection(session2, timeoutMs),
    ]);
    return { session1: conn1, session2: conn2 };
  }
}

module.exports = {
  TestInstance,
  SDPNegotiator,
  MessageExchanger,
  ConnectionWaiter,
};
