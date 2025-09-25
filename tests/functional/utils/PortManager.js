const portfinder = require("portfinder");

class PortManager {
  constructor() {
    this.allocatedPorts = new Set();
    this.basePort = 20000; // Start from high port to avoid conflicts
    this.maxPort = 65535;
  }

  async allocatePort() {
    let attempts = 0;
    const maxAttempts = 50;

    while (attempts < maxAttempts) {
      try {
        // Use random starting point to avoid conflicts
        const randomOffset = Math.floor(Math.random() * 1000);
        const startPort = this.basePort + randomOffset + attempts * 100;

        const port = await portfinder.getPortPromise({
          port: startPort,
          stopPort: this.maxPort,
        });

        if (!this.allocatedPorts.has(port)) {
          this.allocatedPorts.add(port);
          console.debug(`PortManager: Allocated port ${port}`);
          return port;
        }

        attempts++;
      } catch (error) {
        console.debug(
          `PortManager: Port allocation attempt ${attempts} failed:`,
          error.message
        );
        attempts++;
      }
    }

    throw new Error("Unable to allocate available port after maximum attempts");
  }

  async allocatePortRange(count = 2) {
    const ports = [];
    for (let i = 0; i < count; i++) {
      const port = await this.allocatePort();
      ports.push(port);
    }
    return ports;
  }

  releasePort(port) {
    this.allocatedPorts.delete(port);
  }

  releaseAllPorts() {
    this.allocatedPorts.clear();
  }

  isPortAllocated(port) {
    return this.allocatedPorts.has(port);
  }

  getAllocatedPorts() {
    return Array.from(this.allocatedPorts);
  }
}

// Global instance
const globalPortManager = new PortManager();

module.exports = {
  PortManager,
  globalPortManager,
};
