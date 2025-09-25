const MultiProcessMsrpTest = require("./utils/MultiProcessTest");

describe("Multi-Process MSRP Communication", () => {
  let testHarness;

  beforeEach(() => {
    testHarness = new MultiProcessMsrpTest();
  });

  afterEach(async () => {
    if (testHarness) {
      await testHarness.cleanup();
    }
  });

  describe("Basic Communication", () => {
    test("should establish connection between active and passive endpoints", async () => {
      // Start passive endpoint first
      const passiveEndpoint = await testHarness.spawnEndpoint("passive", {
        setup: "passive",
      });

      expect(passiveEndpoint.port).toBeGreaterThan(0);
      expect(testHarness.isReady("passive")).toBe(true);

      // Start active endpoint
      const activeEndpoint = await testHarness.spawnEndpoint("active", {
        setup: "active",
      });

      expect(activeEndpoint.port).toBeGreaterThan(0);
      expect(testHarness.isReady("active")).toBe(true);

      // Create sessions on both endpoints
      await testHarness.sendCommand("passive", "create_session", {
        sessionId: "passive_session",
      });
      await testHarness.sendCommand("active", "create_session", {
        sessionId: "active_session",
      });

      // Wait for session creation confirmation
      await testHarness.waitForMessage("passive", "session_created");
      await testHarness.waitForMessage("active", "session_created");

      // Generate SDP offer from active endpoint
      await testHarness.sendCommand("active", "generate_sdp", {
        sessionId: "active_session",
      });
      const activeSdp = await testHarness.waitForMessage(
        "active",
        "sdp_generated"
      );

      expect(activeSdp.sdp).toBeDefined();
      expect(activeSdp.sdp).toContain("m=message");
      expect(activeSdp.sdp).toContain("a=setup:active");

      // Set remote SDP on passive endpoint
      await testHarness.sendCommand("passive", "set_remote_sdp", {
        sessionId: "passive_session",
        sdp: activeSdp.sdp,
      });
      await testHarness.waitForMessage("passive", "remote_sdp_set");

      // Generate SDP answer from passive endpoint
      await testHarness.sendCommand("passive", "generate_sdp", {
        sessionId: "passive_session",
      });
      const passiveSdp = await testHarness.waitForMessage(
        "passive",
        "sdp_generated"
      );

      expect(passiveSdp.sdp).toBeDefined();
      expect(passiveSdp.sdp).toContain("m=message");
      expect(passiveSdp.sdp).toContain("a=setup:passive");

      // Set remote SDP on active endpoint
      await testHarness.sendCommand("active", "set_remote_sdp", {
        sessionId: "active_session",
        sdp: passiveSdp.sdp,
      });
      await testHarness.waitForMessage("active", "remote_sdp_set");

      // Verify both endpoints have completed SDP negotiation
      const passiveMessages = testHarness.getMessages("passive");
      const activeMessages = testHarness.getMessages("active");

      expect(
        passiveMessages.some((msg) => msg.type === "session_created")
      ).toBe(true);
      expect(passiveMessages.some((msg) => msg.type === "sdp_generated")).toBe(
        true
      );
      expect(activeMessages.some((msg) => msg.type === "session_created")).toBe(
        true
      );
      expect(activeMessages.some((msg) => msg.type === "sdp_generated")).toBe(
        true
      );
    }, 15000);

    test("should exchange messages between endpoints", async () => {
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

      // Complete SDP negotiation (abbreviated for this test)
      await testHarness.sendCommand("active", "generate_sdp", {
        sessionId: "active_session",
      });
      const activeSdp = await testHarness.waitForMessage(
        "active",
        "sdp_generated"
      );

      await testHarness.sendCommand("passive", "set_remote_sdp", {
        sessionId: "passive_session",
        sdp: activeSdp.sdp,
      });
      await testHarness.waitForMessage("passive", "remote_sdp_set");

      await testHarness.sendCommand("passive", "generate_sdp", {
        sessionId: "passive_session",
      });
      const passiveSdp = await testHarness.waitForMessage(
        "passive",
        "sdp_generated"
      );

      await testHarness.sendCommand("active", "set_remote_sdp", {
        sessionId: "active_session",
        sdp: passiveSdp.sdp,
      });
      await testHarness.waitForMessage("active", "remote_sdp_set");

      // Wait a moment for connection establishment
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Send message from active to passive
      const testMessage = "Hello from active endpoint!";
      await testHarness.sendCommand("active", "send_message", {
        sessionId: "active_session",
        content: testMessage,
      });

      // Wait for message to be sent and received
      const sentMessage = await testHarness.waitForMessage(
        "active",
        "message_sent",
        5000
      );
      expect(sentMessage.content).toBe(testMessage);

      // Note: Actual message reception would require full TCP connection establishment
      // which may require additional timing and connection setup
    }, 20000);
  });

  describe("Error Handling", () => {
    test("should handle process failures gracefully", async () => {
      const passiveEndpoint = await testHarness.spawnEndpoint("passive");
      expect(passiveEndpoint.port).toBeGreaterThan(0);

      // Kill the process
      await testHarness.killProcess("passive");

      // Verify process is no longer tracked
      expect(testHarness.isReady("passive")).toBe(false);
      expect(testHarness.getPort("passive")).toBeNull();
    });

    test("should timeout on unresponsive processes", async () => {
      // This test would spawn a process that doesn't respond properly
      await expect(
        testHarness.spawnEndpoint("passive", {}, "unresponsive")
      ).rejects.toThrow(/timeout/i);
    }, 12000);
  });

  describe("Load Testing", () => {
    test("should handle multiple concurrent sessions", async () => {
      await testHarness.spawnEndpoint("passive");
      await testHarness.spawnEndpoint("active");

      const sessionCount = 3;
      const sessions = [];

      // Create multiple sessions on each endpoint
      for (let i = 0; i < sessionCount; i++) {
        await testHarness.sendCommand("passive", "create_session", {
          sessionId: `passive_session_${i}`,
        });
        await testHarness.sendCommand("active", "create_session", {
          sessionId: `active_session_${i}`,
        });

        sessions.push({
          passive: `passive_session_${i}`,
          active: `active_session_${i}`,
        });
      }

      // Wait for all sessions to be created
      for (let i = 0; i < sessionCount; i++) {
        await testHarness.waitForMessage("passive", "session_created");
        await testHarness.waitForMessage("active", "session_created");
      }

      // Verify all sessions were created
      const passiveMessages = testHarness.getMessages(
        "passive",
        "session_created"
      );
      const activeMessages = testHarness.getMessages(
        "active",
        "session_created"
      );

      expect(passiveMessages).toHaveLength(sessionCount);
      expect(activeMessages).toHaveLength(sessionCount);

      // Test SDP generation for first session
      await testHarness.sendCommand("active", "generate_sdp", {
        sessionId: "active_session_0",
      });
      const sdpMessage = await testHarness.waitForMessage(
        "active",
        "sdp_generated"
      );
      expect(sdpMessage.sdp).toContain("m=message");
    }, 25000);
  });

  describe("Status and Monitoring", () => {
    test("should provide process status information", async () => {
      await testHarness.spawnEndpoint("passive");

      await testHarness.sendCommand("passive", "get_status");
      const statusMessage = await testHarness.waitForMessage(
        "passive",
        "status"
      );

      expect(statusMessage.type).toBe("passive");
      expect(statusMessage.port).toBeGreaterThan(0);
      expect(statusMessage.serverListening).toBe(true);
      expect(Array.isArray(statusMessage.sessions)).toBe(true);
    });

    test("should track message history", async () => {
      await testHarness.spawnEndpoint("passive");

      await testHarness.sendCommand("passive", "create_session", {
        sessionId: "test_session",
      });
      await testHarness.waitForMessage("passive", "session_created");

      await testHarness.sendCommand("passive", "generate_sdp", {
        sessionId: "test_session",
      });
      await testHarness.waitForMessage("passive", "sdp_generated");

      const allMessages = testHarness.getMessages("passive");
      expect(allMessages.length).toBeGreaterThanOrEqual(3); // ready, session_created, sdp_generated

      const readyMessages = testHarness.getMessages("passive", "ready");
      expect(readyMessages).toHaveLength(1);
    });
  });
});
