const { globalPortManager } = require("./utils/PortManager");

// Global test setup
beforeEach(() => {
  // Reset port allocations for each test
  globalPortManager.releaseAllPorts();
});

afterEach(async () => {
  // Cleanup after each test
  globalPortManager.releaseAllPorts();

  // Small delay to ensure ports are released
  await new Promise((resolve) => setTimeout(resolve, 100));
});

// Increase Jest timeout for functional tests
jest.setTimeout(30000);

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

// Optional: Set environment variables for testing
process.env.NODE_ENV = "test";
