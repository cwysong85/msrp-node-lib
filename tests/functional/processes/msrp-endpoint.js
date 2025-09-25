#!/usr/bin/env node

/**
 * MSRP Endpoint Process
 * Runs as a separate Node.js process to enable true multi-process MSRP communication
 */

const MsrpSdkFactory = require("../../../src/MsrpSdk.js");
const readline = require("readline");

class MsrpEndpointProcess {
  constructor() {
    this.config = null;
    this.msrpSdk = null;
    this.sessions = new Map();
    this.connections = new Map();
    this.messageHandlers = new Map();

    // Setup stdin for commands
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    this.rl.on("line", (line) => {
      try {
        const command = JSON.parse(line.trim());
        this.handleCommand(command);
      } catch (error) {
        this.sendMessage("error", {
          error: `Invalid command: ${error.message}`,
        });
      }
    });

    // Handle process signals
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
    process.on("uncaughtException", (error) => {
      this.sendMessage("error", { error: error.message, stack: error.stack });
      process.exit(1);
    });
  }

  async initialize() {
    try {
      // Parse config from environment
      const configStr = process.env.MSRP_CONFIG;
      if (!configStr) {
        throw new Error("MSRP_CONFIG environment variable not set");
      }

      const processConfig = JSON.parse(configStr);
      this.config = processConfig.config;
      this.type = processConfig.type;
      this.scenario = processConfig.scenario;

      // Create MSRP SDK instance
      this.msrpSdk = MsrpSdkFactory(this.config, {
        debug: (msg) => console.error(`[DEBUG] ${msg}`),
        info: (msg) => console.error(`[INFO] ${msg}`),
        warn: (msg) => console.error(`[WARN] ${msg}`),
        error: (msg) => console.error(`[ERROR] ${msg}`),
      });

      // Start server
      await this.startServer();

      // Send ready signal
      this.sendMessage("ready", {
        port: this.actualPort,
        endpointType: this.type,
        scenario: this.scenario,
      });
    } catch (error) {
      this.sendMessage("error", { error: error.message });
      process.exit(1);
    }
  }

  async startServer() {
    return new Promise((resolve, reject) => {
      this.msrpSdk.Server.start((error) => {
        if (error) {
          reject(error);
        } else {
          this.actualPort = this.msrpSdk.Server.server.address().port;
          this.msrpSdk.Config.port = this.actualPort;
          resolve();
        }
      });
    });
  }

  sendMessage(type, data = {}) {
    const message = { type, timestamp: Date.now(), ...data };
    console.log(JSON.stringify(message));
  }

  async handleCommand(command) {
    try {
      switch (command.command) {
        case "create_session":
          await this.createSession(command.sessionId);
          break;
        case "generate_sdp":
          await this.generateSdp(command.sessionId);
          break;
        case "set_remote_sdp":
          await this.setRemoteSdp(command.sessionId, command.sdp);
          break;
        case "send_message":
          await this.sendMsrpMessage(
            command.sessionId,
            command.content,
            command.contentType
          );
          break;
        case "connect_to":
          await this.connectTo(command.host, command.port);
          break;
        case "get_status":
          this.getStatus();
          break;
        default:
          this.sendMessage("error", {
            error: `Unknown command: ${command.command}`,
          });
      }
    } catch (error) {
      this.sendMessage("error", {
        error: error.message,
        command: command.command,
        stack: error.stack,
      });
    }
  }

  async createSession(sessionId = null) {
    sessionId = sessionId || `session_${Date.now()}`;

    const session = this.msrpSdk.SessionController.createSession();
    this.sessions.set(sessionId, session);

    // Setup event handlers
    session.on("socketConnect", () => {
      this.sendMessage("connection_established", { sessionId });
    });

    session.on("socketError", (error) => {
      this.sendMessage("session_error", { sessionId, error: error.message });
    });

    session.on("message", (message) => {
      this.sendMessage("message_received", {
        sessionId,
        content: message.body,
        contentType: message.contentType,
        messageId: message.messageId,
      });
    });

    this.sendMessage("session_created", {
      sessionId,
      msrpSessionId: session.sid,
    });
    return sessionId;
  }

  async generateSdp(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return new Promise((resolve, reject) => {
      session.getDescription(
        (sdp) => {
          this.sendMessage("sdp_generated", { sessionId, sdp });
          resolve(sdp);
        },
        (error) => {
          reject(new Error(`SDP generation failed: ${error}`));
        }
      );
    });
  }

  async setRemoteSdp(sessionId, remoteSdp) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return new Promise((resolve, reject) => {
      session.setDescription(
        remoteSdp,
        () => {
          this.sendMessage("remote_sdp_set", { sessionId });
          resolve();
        },
        (error) => {
          reject(new Error(`Set remote SDP failed: ${error}`));
        }
      );
    });
  }

  async sendMsrpMessage(sessionId, content, contentType = "text/plain") {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return new Promise((resolve, reject) => {
      session.sendMessage(
        content,
        (success) => {
          if (success) {
            this.sendMessage("message_sent", {
              sessionId,
              content,
              contentType,
            });
            resolve();
          } else {
            reject(new Error("Failed to send message"));
          }
        },
        contentType
      );
    });
  }

  async connectTo(host, port) {
    // This would be used for active endpoint to connect to passive
    this.sendMessage("connecting_to", { host, port });
  }

  getStatus() {
    const status = {
      type: this.type,
      port: this.actualPort,
      sessions: Array.from(this.sessions.keys()),
      serverListening: this.msrpSdk.Server.server?.listening || false,
    };
    this.sendMessage("status", status);
  }

  async shutdown() {
    try {
      console.error("[INFO] Shutting down MSRP endpoint process...");

      // Clear sessions
      for (const [sessionId, session] of this.sessions) {
        try {
          if (!session.ended) {
            session.end();
          }
          this.msrpSdk.SessionController.removeSession(session);
        } catch (error) {
          console.error(
            `[WARN] Error cleaning up session ${sessionId}:`,
            error.message
          );
        }
      }
      this.sessions.clear();

      // Stop server
      if (this.msrpSdk && this.msrpSdk.Server) {
        await new Promise((resolve) => {
          this.msrpSdk.Server.stop(() => {
            console.error("[INFO] Server stopped");
            resolve();
          });
        });
      }

      this.sendMessage("shutdown_complete");
      process.exit(0);
    } catch (error) {
      console.error("[ERROR] Shutdown error:", error.message);
      process.exit(1);
    }
  }
}

// Start the process
const endpoint = new MsrpEndpointProcess();
endpoint.initialize().catch((error) => {
  console.error("[ERROR] Failed to initialize endpoint:", error.message);
  process.exit(1);
});
