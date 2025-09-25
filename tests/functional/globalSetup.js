const { globalPortManager } = require("./utils/PortManager");

module.exports = async () => {
  console.log("Setting up functional tests...");

  // Ensure clean state
  globalPortManager.releaseAllPorts();

  // Any global setup needed
};
