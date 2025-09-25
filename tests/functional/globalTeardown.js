const { globalPortManager } = require("./utils/PortManager");

module.exports = async () => {
  console.log("Tearing down functional tests...");

  // Cleanup any global resources
  globalPortManager.releaseAllPorts();

  // Small delay to ensure cleanup
  await new Promise((resolve) => setTimeout(resolve, 200));
};
