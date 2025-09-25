module.exports = {
  displayName: "Functional Tests",
  testEnvironment: "node",
  testMatch: ["**/tests/functional/**/*.functional.test.js"],
  setupFilesAfterEnv: ["<rootDir>/setup.js"],
  testTimeout: 45000, // 45 seconds for multi-process operations
  collectCoverageFrom: ["src/**/*.js", "!src/**/*.test.js"],
  coverageDirectory: "coverage/functional",
  coverageReporters: ["text", "lcov", "html"],
  // Run tests serially to avoid conflicts and resource limits
  maxWorkers: 1,
  // Increase timeout for setup/teardown
  globalSetup: "<rootDir>/globalSetup.js",
  globalTeardown: "<rootDir>/globalTeardown.js",
  // Increase memory limits for multi-process tests
  workerIdleMemoryLimit: "1GB",
  // Enable verbose logging for multi-process debugging
  verbose: false,
};
