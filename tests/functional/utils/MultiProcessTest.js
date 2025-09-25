const { spawn } = require("child_process");
const path = require("path");
const EventEmitter = require("events");

/**
 * Multi-process MSRP test infrastructure
 * Spawns separate Node.js processes for MSRP endpoints to enable real communication
 */
class MultiProcessMsrpTest extends EventEmitter {
  constructor() {
    super();
    this.processes = new Map();
    this.testResults = new Map();
    this.cleanup = [];
  }

  /**
   * Spawn a new MSRP endpoint process
   * @param {string} endpointType - 'active' or 'passive'
   * @param {Object} config - MSRP configuration
   * @param {string} testScenario - Test scenario to run
   * @returns {Promise<Object>} Process info with port and pid
   */
  async spawnEndpoint(endpointType, config = {}, testScenario = "basic") {
    return new Promise((resolve, reject) => {
      const endpointScript = path.join(
        __dirname,
        "..",
        "processes",
        "msrp-endpoint.js"
      );

      const processConfig = {
        type: endpointType,
        scenario: testScenario,
        config: {
          host: "127.0.0.1",
          port: 0, // OS-assigned
          setup: endpointType,
          sessionName: `${endpointType} session`,
          acceptTypes: "text/plain",
          traceMsrp: false,
          ...config,
        },
      };

      const child = spawn("node", [endpointScript], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, MSRP_CONFIG: JSON.stringify(processConfig) },
      });

      const processInfo = {
        pid: child.pid,
        type: endpointType,
        process: child,
        port: null,
        ready: false,
        messages: [],
      };

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
        const lines = stdout.split("\n");

        for (const line of lines) {
          if (line.trim()) {
            try {
              const message = JSON.parse(line.trim());
              this.handleProcessMessage(processInfo, message);

              if (message.type === "ready" && !processInfo.ready) {
                processInfo.ready = true;
                processInfo.port = message.port;
                resolve(processInfo);
              }
            } catch (e) {
              // Non-JSON output, treat as log
              console.log(`[${endpointType}] ${line.trim()}`);
            }
          }
        }
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
        console.error(`[${endpointType}] ERROR:`, data.toString().trim());
      });

      child.on("close", (code) => {
        if (code !== 0 && !processInfo.ready) {
          reject(
            new Error(
              `${endpointType} process exited with code ${code}. stderr: ${stderr}`
            )
          );
        }
      });

      child.on("error", (error) => {
        reject(
          new Error(`Failed to spawn ${endpointType} process: ${error.message}`)
        );
      });

      this.processes.set(endpointType, processInfo);
      this.cleanup.push(() => this.killProcess(endpointType));

      // Timeout for process startup
      setTimeout(() => {
        if (!processInfo.ready) {
          reject(
            new Error(`${endpointType} process failed to start within timeout`)
          );
        }
      }, 10000);
    });
  }

  /**
   * Handle messages from child processes
   */
  handleProcessMessage(processInfo, message) {
    processInfo.messages.push(message);
    this.emit("processMessage", processInfo.type, message);

    switch (message.type) {
      case "ready":
        console.log(`[${processInfo.type}] Ready on port ${message.port}`);
        break;
      case "session_created":
        console.log(
          `[${processInfo.type}] Session created: ${message.sessionId}`
        );
        break;
      case "sdp_generated":
        console.log(`[${processInfo.type}] SDP generated`);
        break;
      case "connection_established":
        console.log(`[${processInfo.type}] Connection established`);
        break;
      case "message_sent":
        console.log(`[${processInfo.type}] Message sent: ${message.content}`);
        break;
      case "message_received":
        console.log(
          `[${processInfo.type}] Message received: ${message.content}`
        );
        break;
      case "error":
        console.error(`[${processInfo.type}] Error: ${message.error}`);
        break;
    }
  }

  /**
   * Send command to a process
   */
  async sendCommand(endpointType, command, data = {}) {
    const processInfo = this.processes.get(endpointType);
    if (!processInfo) {
      throw new Error(`No process found for endpoint: ${endpointType}`);
    }

    const message = { command, ...data };
    processInfo.process.stdin.write(JSON.stringify(message) + "\n");
  }

  /**
   * Wait for a specific message from a process
   */
  async waitForMessage(endpointType, messageType, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const processInfo = this.processes.get(endpointType);
      if (!processInfo) {
        reject(new Error(`No process found for endpoint: ${endpointType}`));
        return;
      }

      // Check if message already exists
      const existingMessage = processInfo.messages.find(
        (msg) => msg.type === messageType
      );
      if (existingMessage) {
        resolve(existingMessage);
        return;
      }

      const timeoutId = setTimeout(() => {
        reject(
          new Error(`Timeout waiting for ${messageType} from ${endpointType}`)
        );
      }, timeout);

      const messageHandler = (type, message) => {
        if (type === endpointType && message.type === messageType) {
          clearTimeout(timeoutId);
          this.removeListener("processMessage", messageHandler);
          resolve(message);
        }
      };

      this.on("processMessage", messageHandler);
    });
  }

  /**
   * Kill a specific process
   */
  async killProcess(endpointType) {
    const processInfo = this.processes.get(endpointType);
    if (processInfo && processInfo.process) {
      processInfo.process.kill("SIGTERM");

      // Wait for graceful shutdown, then force kill if needed
      setTimeout(() => {
        if (!processInfo.process.killed) {
          processInfo.process.kill("SIGKILL");
        }
      }, 2000);

      this.processes.delete(endpointType);
    }
  }

  /**
   * Cleanup all processes
   */
  async cleanup() {
    for (const cleanupFn of this.cleanup) {
      try {
        await cleanupFn();
      } catch (error) {
        console.warn("Cleanup error:", error.message);
      }
    }
    this.cleanup = [];
    this.processes.clear();
  }

  /**
   * Get messages from a process
   */
  getMessages(endpointType, messageType = null) {
    const processInfo = this.processes.get(endpointType);
    if (!processInfo) return [];

    if (messageType) {
      return processInfo.messages.filter((msg) => msg.type === messageType);
    }
    return processInfo.messages;
  }

  /**
   * Check if process is ready
   */
  isReady(endpointType) {
    const processInfo = this.processes.get(endpointType);
    return processInfo && processInfo.ready;
  }

  /**
   * Get process port
   */
  getPort(endpointType) {
    const processInfo = this.processes.get(endpointType);
    return processInfo ? processInfo.port : null;
  }

  /**
   * Cleanup all spawned processes
   */
  async cleanup() {
    const cleanupPromises = [];

    for (const [endpointType, processInfo] of this.processes) {
      if (processInfo.child && !processInfo.child.killed) {
        console.log(`Cleaning up ${endpointType} process...`);

        const cleanupPromise = new Promise((resolve) => {
          const timeout = setTimeout(() => {
            console.log(`Force killing ${endpointType} process...`);
            processInfo.child.kill("SIGKILL");
            resolve();
          }, 5000);

          processInfo.child.on("exit", () => {
            clearTimeout(timeout);
            resolve();
          });

          processInfo.child.kill("SIGTERM");
        });

        cleanupPromises.push(cleanupPromise);
      }
    }

    await Promise.all(cleanupPromises);
    this.processes.clear();
    this.testResults.clear();
  }
}

module.exports = MultiProcessMsrpTest;
