const MultiProcessMsrpTest = require("./MultiProcessTest");

/**
 * Advanced multi-process MSRP test scenarios
 * Provides high-level test patterns for common MSRP communication scenarios
 */
class MsrpTestScenarios {
  constructor() {
    this.testHarness = new MultiProcessMsrpTest();
  }

  /**
   * Complete SDP negotiation between two endpoints
   */
  async performSdpNegotiation(
    activeSessionId = "active_session",
    passiveSessionId = "passive_session"
  ) {
    // Generate offer from active endpoint
    await this.testHarness.sendCommand("active", "generate_sdp", {
      sessionId: activeSessionId,
    });
    const activeSdp = await this.testHarness.waitForMessage(
      "active",
      "sdp_generated"
    );

    // Set remote SDP on passive endpoint
    await this.testHarness.sendCommand("passive", "set_remote_sdp", {
      sessionId: passiveSessionId,
      sdp: activeSdp.sdp,
    });
    await this.testHarness.waitForMessage("passive", "remote_sdp_set");

    // Generate answer from passive endpoint
    await this.testHarness.sendCommand("passive", "generate_sdp", {
      sessionId: passiveSessionId,
    });
    const passiveSdp = await this.testHarness.waitForMessage(
      "passive",
      "sdp_generated"
    );

    // Set remote SDP on active endpoint
    await this.testHarness.sendCommand("active", "set_remote_sdp", {
      sessionId: activeSessionId,
      sdp: passiveSdp.sdp,
    });
    await this.testHarness.waitForMessage("active", "remote_sdp_set");

    return {
      offer: activeSdp.sdp,
      answer: passiveSdp.sdp,
    };
  }

  /**
   * Setup a complete MSRP communication session
   */
  async setupCommunicationSession() {
    // Start both endpoints
    const passiveEndpoint = await this.testHarness.spawnEndpoint("passive", {
      setup: "passive",
    });

    const activeEndpoint = await this.testHarness.spawnEndpoint("active", {
      setup: "active",
    });

    // Create sessions
    await this.testHarness.sendCommand("passive", "create_session", {
      sessionId: "passive_session",
    });
    await this.testHarness.sendCommand("active", "create_session", {
      sessionId: "active_session",
    });

    // Wait for session creation
    await this.testHarness.waitForMessage("passive", "session_created");
    await this.testHarness.waitForMessage("active", "session_created");

    // Perform SDP negotiation
    const sdpResult = await this.performSdpNegotiation();

    // Wait for connection establishment
    await new Promise((resolve) => setTimeout(resolve, 2000));

    return {
      passive: passiveEndpoint,
      active: activeEndpoint,
      sdp: sdpResult,
    };
  }

  /**
   * Test bidirectional message exchange
   */
  async testBidirectionalMessaging() {
    await this.setupCommunicationSession();

    const messages = [
      { from: "active", to: "passive", content: "Hello from active!" },
      { from: "passive", to: "active", content: "Hello from passive!" },
      { from: "active", to: "passive", content: "How are you?" },
      { from: "passive", to: "active", content: "I am fine, thanks!" },
    ];

    const results = [];

    for (const message of messages) {
      const sessionId = `${message.from}_session`;

      await this.testHarness.sendCommand(message.from, "send_message", {
        sessionId,
        content: message.content,
      });

      const sentMessage = await this.testHarness.waitForMessage(
        message.from,
        "message_sent"
      );
      results.push({
        sent: sentMessage,
        originalMessage: message,
      });

      // Small delay between messages
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    return results;
  }

  /**
   * Test different content types
   */
  async testContentTypes() {
    await this.setupCommunicationSession();

    const contentTypes = [
      { type: "text/plain", content: "Plain text message" },
      {
        type: "application/json",
        content: JSON.stringify({
          message: "JSON message",
          timestamp: Date.now(),
        }),
      },
      { type: "text/html", content: "<p>HTML message</p>" },
    ];

    const results = [];

    for (const contentTest of contentTypes) {
      await this.testHarness.sendCommand("active", "send_message", {
        sessionId: "active_session",
        content: contentTest.content,
        contentType: contentTest.type,
      });

      const sentMessage = await this.testHarness.waitForMessage(
        "active",
        "message_sent"
      );
      results.push({
        contentType: contentTest.type,
        sent: sentMessage,
      });
    }

    return results;
  }

  /**
   * Test session cleanup and reconnection
   */
  async testSessionLifecycle() {
    const session1 = await this.setupCommunicationSession();

    // Send a message in first session
    await this.testHarness.sendCommand("active", "send_message", {
      sessionId: "active_session",
      content: "Message in session 1",
    });
    await this.testHarness.waitForMessage("active", "message_sent");

    // Cleanup processes
    await this.testHarness.cleanup();

    // Start new session
    const session2 = await this.setupCommunicationSession();

    // Send a message in second session
    await this.testHarness.sendCommand("active", "send_message", {
      sessionId: "active_session",
      content: "Message in session 2",
    });
    await this.testHarness.waitForMessage("active", "message_sent");

    return {
      session1: session1,
      session2: session2,
    };
  }

  /**
   * Load test with multiple concurrent sessions
   */
  async loadTestMultipleSessions(sessionCount = 5) {
    await this.testHarness.spawnEndpoint("passive");
    await this.testHarness.spawnEndpoint("active");

    const sessions = [];

    // Create multiple sessions
    for (let i = 0; i < sessionCount; i++) {
      await this.testHarness.sendCommand("passive", "create_session", {
        sessionId: `passive_session_${i}`,
      });
      await this.testHarness.sendCommand("active", "create_session", {
        sessionId: `active_session_${i}`,
      });

      sessions.push(i);
    }

    // Wait for all sessions to be created
    for (let i = 0; i < sessionCount; i++) {
      await this.testHarness.waitForMessage("passive", "session_created");
      await this.testHarness.waitForMessage("active", "session_created");
    }

    // Perform SDP negotiation for all sessions
    const sdpResults = [];
    for (let i = 0; i < sessionCount; i++) {
      const sdpResult = await this.performSdpNegotiation(
        `active_session_${i}`,
        `passive_session_${i}`
      );
      sdpResults.push({ sessionIndex: i, sdp: sdpResult });
    }

    return {
      sessionCount,
      sessions,
      sdpResults,
    };
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    await this.testHarness.cleanup();
  }

  /**
   * Get test harness for direct access
   */
  getTestHarness() {
    return this.testHarness;
  }
}

module.exports = MsrpTestScenarios;
