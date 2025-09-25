const MultiProcessMsrpTest = require("./utils/MultiProcessTest");

describe("Multi-Process MSRP Communication - Simplified", () => {
  test("should demonstrate real MSRP communication between processes", async () => {
    console.log("🚀 Starting multi-process MSRP communication test...");

    const testHarness = new MultiProcessMsrpTest();

    try {
      // Start passive endpoint first
      console.log("1. Starting passive endpoint...");
      const passiveEndpoint = await testHarness.spawnEndpoint("passive", {
        setup: "passive",
      });
      console.log(`✅ Passive endpoint ready on port ${passiveEndpoint.port}`);

      // Start active endpoint
      console.log("2. Starting active endpoint...");
      const activeEndpoint = await testHarness.spawnEndpoint("active", {
        setup: "active",
      });
      console.log(`✅ Active endpoint ready on port ${activeEndpoint.port}`);

      // Create sessions
      console.log("3. Creating MSRP sessions...");
      await testHarness.sendCommand("passive", "create_session", {
        sessionId: "passive_session",
      });

      await testHarness.sendCommand("active", "create_session", {
        sessionId: "active_session",
      });
      console.log("✅ Sessions created");

      // Generate SDP offers
      console.log("4. Generating SDP...");
      await testHarness.sendCommand("active", "generate_sdp", {
        sessionId: "active_session",
      });

      const activeSdpMessage = await testHarness.waitForMessage(
        "active",
        "sdp_generated",
        5000
      );
      console.log("✅ Active SDP generated");

      // Process SDP on passive side
      await testHarness.sendCommand("passive", "set_remote_sdp", {
        sessionId: "passive_session",
        sdp: activeSdpMessage.sdp,
      });
      console.log("✅ Passive processed active SDP");

      // Generate passive SDP
      await testHarness.sendCommand("passive", "generate_sdp", {
        sessionId: "passive_session",
      });

      const passiveSdpMessage = await testHarness.waitForMessage(
        "passive",
        "sdp_generated",
        5000
      );
      console.log("✅ Passive SDP generated");

      // Process passive SDP on active side
      await testHarness.sendCommand("active", "set_remote_sdp", {
        sessionId: "active_session",
        sdp: passiveSdpMessage.sdp,
      });
      console.log("✅ Active processed passive SDP");

      // Wait a moment for connection establishment
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Send message from active to passive
      console.log("5. Sending message from active to passive...");
      await testHarness.sendCommand("active", "send_message", {
        sessionId: "active_session",
        content: "Hello from active endpoint!",
        contentType: "text/plain",
      });

      // Wait for message reception
      const receivedMessage = await testHarness.waitForMessage(
        "passive",
        "message_received",
        5000
      );
      console.log("✅ Message received:", receivedMessage.message);

      // Verify the message content
      expect(receivedMessage.message).toBe("Hello from active endpoint!");

      console.log("🎉 SUCCESS: Multi-process MSRP communication is working!");
      console.log(
        "📊 Test completed successfully with real MSRP message exchange between separate processes"
      );
    } finally {
      // Manual cleanup
      console.log("6. Cleaning up processes...");
      if (testHarness && typeof testHarness.cleanup === "function") {
        await testHarness.cleanup();
      }
      console.log("✅ Cleanup completed");
    }
  }, 30000); // 30 second timeout for this comprehensive test
});
