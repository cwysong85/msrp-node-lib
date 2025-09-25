const MsrpTestScenarios = require("./utils/MsrpTestScenarios");

describe("Advanced Multi-Process MSRP Scenarios", () => {
  let scenarios;

  beforeEach(() => {
    scenarios = new MsrpTestScenarios();
  });

  afterEach(async () => {
    if (scenarios) {
      await scenarios.cleanup();
    }
  });

  describe("Complete Communication Flow", () => {
    test("should perform complete SDP negotiation", async () => {
      const testHarness = scenarios.getTestHarness();

      // Start both endpoints
      await testHarness.spawnEndpoint("passive");
      await testHarness.spawnEndpoint("active");

      // Create sessions
      await testHarness.sendCommand("passive", "create_session", {
        sessionId: "passive_session",
      });
      await testHarness.sendCommand("active", "create_session", {
        sessionId: "active_session",
      });

      await testHarness.waitForMessage("passive", "session_created");
      await testHarness.waitForMessage("active", "session_created");

      // Perform SDP negotiation
      const sdpResult = await scenarios.performSdpNegotiation();

      expect(sdpResult.offer).toBeDefined();
      expect(sdpResult.answer).toBeDefined();
      expect(sdpResult.offer).toContain("a=setup:active");
      expect(sdpResult.answer).toContain("a=setup:passive");
      expect(sdpResult.offer).toContain("m=message");
      expect(sdpResult.answer).toContain("m=message");
    }, 20000);

    test("should setup complete communication session", async () => {
      const sessionResult = await scenarios.setupCommunicationSession();

      expect(sessionResult.passive.port).toBeGreaterThan(0);
      expect(sessionResult.active.port).toBeGreaterThan(0);
      expect(sessionResult.sdp.offer).toBeDefined();
      expect(sessionResult.sdp.answer).toBeDefined();

      // Verify endpoints are ready
      const testHarness = scenarios.getTestHarness();
      expect(testHarness.isReady("passive")).toBe(true);
      expect(testHarness.isReady("active")).toBe(true);
    }, 25000);
  });

  describe("Message Exchange Scenarios", () => {
    test("should handle bidirectional messaging", async () => {
      const results = await scenarios.testBidirectionalMessaging();

      expect(results).toHaveLength(4);

      // Verify all messages were sent
      results.forEach((result, index) => {
        expect(result.sent.content).toBe(result.originalMessage.content);
        expect(result.sent.sessionId).toContain(result.originalMessage.from);
      });

      // Verify message order and content
      expect(results[0].originalMessage.content).toBe("Hello from active!");
      expect(results[1].originalMessage.content).toBe("Hello from passive!");
      expect(results[2].originalMessage.content).toBe("How are you?");
      expect(results[3].originalMessage.content).toBe("I am fine, thanks!");
    }, 30000);

    test("should handle different content types", async () => {
      const results = await scenarios.testContentTypes();

      expect(results).toHaveLength(3);

      const textResult = results.find((r) => r.contentType === "text/plain");
      const jsonResult = results.find(
        (r) => r.contentType === "application/json"
      );
      const htmlResult = results.find((r) => r.contentType === "text/html");

      expect(textResult).toBeDefined();
      expect(textResult.sent.content).toBe("Plain text message");

      expect(jsonResult).toBeDefined();
      expect(() => JSON.parse(jsonResult.sent.content)).not.toThrow();

      expect(htmlResult).toBeDefined();
      expect(htmlResult.sent.content).toContain("<p>");
    }, 25000);
  });

  describe("Session Lifecycle Management", () => {
    test("should handle session cleanup and reconnection", async () => {
      const result = await scenarios.testSessionLifecycle();

      expect(result.session1.passive.port).toBeGreaterThan(0);
      expect(result.session1.active.port).toBeGreaterThan(0);
      expect(result.session2.passive.port).toBeGreaterThan(0);
      expect(result.session2.active.port).toBeGreaterThan(0);

      // Ports should be different (new processes)
      expect(result.session1.passive.port).not.toBe(
        result.session2.passive.port
      );
      expect(result.session1.active.port).not.toBe(result.session2.active.port);
    }, 45000);
  });

  describe("Load Testing", () => {
    test("should handle multiple concurrent sessions", async () => {
      const sessionCount = 3;
      const result = await scenarios.loadTestMultipleSessions(sessionCount);

      expect(result.sessionCount).toBe(sessionCount);
      expect(result.sessions).toHaveLength(sessionCount);
      expect(result.sdpResults).toHaveLength(sessionCount);

      // Verify all SDP negotiations succeeded
      result.sdpResults.forEach((sdpResult, index) => {
        expect(sdpResult.sessionIndex).toBe(index);
        expect(sdpResult.sdp.offer).toContain("m=message");
        expect(sdpResult.sdp.answer).toContain("m=message");
      });

      // Verify message counts
      const testHarness = scenarios.getTestHarness();
      const passiveSessionMessages = testHarness.getMessages(
        "passive",
        "session_created"
      );
      const activeSessionMessages = testHarness.getMessages(
        "active",
        "session_created"
      );

      expect(passiveSessionMessages).toHaveLength(sessionCount);
      expect(activeSessionMessages).toHaveLength(sessionCount);
    }, 40000);

    test("should handle rapid session creation", async () => {
      const testHarness = scenarios.getTestHarness();

      await testHarness.spawnEndpoint("passive");
      await testHarness.spawnEndpoint("active");

      // Create sessions rapidly
      const sessionPromises = [];
      for (let i = 0; i < 5; i++) {
        sessionPromises.push(
          testHarness.sendCommand("passive", "create_session", {
            sessionId: `rapid_passive_${i}`,
          })
        );
        sessionPromises.push(
          testHarness.sendCommand("active", "create_session", {
            sessionId: `rapid_active_${i}`,
          })
        );
      }

      await Promise.all(sessionPromises);

      // Wait for all confirmations
      for (let i = 0; i < 10; i++) {
        // 5 passive + 5 active
        if (i % 2 === 0) {
          await testHarness.waitForMessage("passive", "session_created");
        } else {
          await testHarness.waitForMessage("active", "session_created");
        }
      }

      const passiveMessages = testHarness.getMessages(
        "passive",
        "session_created"
      );
      const activeMessages = testHarness.getMessages(
        "active",
        "session_created"
      );

      expect(passiveMessages).toHaveLength(5);
      expect(activeMessages).toHaveLength(5);
    }, 30000);
  });

  describe("Error Scenarios", () => {
    test("should handle invalid commands gracefully", async () => {
      const testHarness = scenarios.getTestHarness();

      await testHarness.spawnEndpoint("passive");

      // Send invalid command
      await testHarness.sendCommand("passive", "invalid_command", {
        data: "test",
      });

      const errorMessage = await testHarness.waitForMessage("passive", "error");
      expect(errorMessage.error).toContain("Unknown command");
    }, 15000);

    test("should handle missing session gracefully", async () => {
      const testHarness = scenarios.getTestHarness();

      await testHarness.spawnEndpoint("passive");

      // Try to generate SDP for non-existent session
      await testHarness.sendCommand("passive", "generate_sdp", {
        sessionId: "nonexistent",
      });

      const errorMessage = await testHarness.waitForMessage("passive", "error");
      expect(errorMessage.error).toContain("Session not found");
    }, 15000);
  });

  describe("Monitoring and Status", () => {
    test("should provide comprehensive status information", async () => {
      await scenarios.setupCommunicationSession();

      const testHarness = scenarios.getTestHarness();

      // Get status from both endpoints
      await testHarness.sendCommand("passive", "get_status");
      await testHarness.sendCommand("active", "get_status");

      const passiveStatus = await testHarness.waitForMessage(
        "passive",
        "status"
      );
      const activeStatus = await testHarness.waitForMessage("active", "status");

      // Verify passive endpoint status
      expect(passiveStatus.type).toBe("passive");
      expect(passiveStatus.port).toBeGreaterThan(0);
      expect(passiveStatus.serverListening).toBe(true);
      expect(passiveStatus.sessions).toContain("passive_session");

      // Verify active endpoint status
      expect(activeStatus.type).toBe("active");
      expect(activeStatus.port).toBeGreaterThan(0);
      expect(activeStatus.serverListening).toBe(true);
      expect(activeStatus.sessions).toContain("active_session");
    }, 25000);

    test("should track message history correctly", async () => {
      const testHarness = scenarios.getTestHarness();

      await testHarness.spawnEndpoint("passive");

      // Perform several operations
      await testHarness.sendCommand("passive", "create_session", {
        sessionId: "history_test",
      });
      await testHarness.waitForMessage("passive", "session_created");

      await testHarness.sendCommand("passive", "generate_sdp", {
        sessionId: "history_test",
      });
      await testHarness.waitForMessage("passive", "sdp_generated");

      await testHarness.sendCommand("passive", "get_status");
      await testHarness.waitForMessage("passive", "status");

      // Check message history
      const allMessages = testHarness.getMessages("passive");
      expect(allMessages.length).toBeGreaterThanOrEqual(4); // ready, session_created, sdp_generated, status

      const messageTypes = allMessages.map((msg) => msg.type);
      expect(messageTypes).toContain("ready");
      expect(messageTypes).toContain("session_created");
      expect(messageTypes).toContain("sdp_generated");
      expect(messageTypes).toContain("status");
    }, 20000);
  });
});
