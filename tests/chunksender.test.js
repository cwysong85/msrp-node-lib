describe("ChunkSender", () => {
  let msrpSdk;
  let ChunkSender;
  let mockSession;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    jest.resetModules();

    // Create mock MsrpSdk
    msrpSdk = {
      Logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
      Util: {
        newTID: jest.fn().mockReturnValue("test-tid-123"),
        newMID: jest.fn().mockReturnValue("test-mid-456"),
      },
      Config: {
        requestReports: true,
      },
      Message: {
        OutgoingRequest: jest.fn(),
        Flag: {
          continued: "+",
          end: "$",
          abort: "#",
        },
      },
      Status: {
        OK: "200",
      },
    };

    // Mock OutgoingRequest constructor
    const mockOutgoingRequest = function (session, method) {
      this.session = session;
      this.method = method;
      this.tid = null;
      this.headers = {};
      this.body = null;
      this.contentType = null;
      this.byteRange = null;
      this.continuationFlag = msrpSdk.Message.Flag.end;
      this.sender = null;

      this.addHeader = jest.fn((name, value) => {
        this.headers[name] = value;
      });
    };
    msrpSdk.Message.OutgoingRequest = jest
      .fn()
      .mockImplementation(mockOutgoingRequest);

    // Create mock session
    mockSession = {
      sid: "test-session-123",
    };

    // Load ChunkSender
    require("../src/ChunkSender.js")(msrpSdk);
    ChunkSender = msrpSdk.ChunkSender;
  });

  describe("Constructor", () => {
    test("should create ChunkSender with string body", () => {
      const body = "Hello World";
      const contentType = "text/plain";

      const sender = new ChunkSender(mockSession, body, contentType);

      expect(sender.session).toBe(mockSession);
      expect(sender.bodyBuffer).toEqual(Buffer.from(body));
      expect(sender.contentType).toBe(contentType);
      expect(sender.size).toBe(body.length);
      expect(sender.sentBytes).toBe(0);
      expect(sender.ackedBytes).toBe(0);
      expect(sender.aborted).toBe(false);
      expect(sender.remoteAbort).toBe(false);
      expect(sender.messageId).toBe("test-mid-456");
      expect(sender.requestReports).toBe(true);
    });

    test("should create ChunkSender with Buffer body", () => {
      const body = Buffer.from("Hello Buffer");
      const contentType = "application/octet-stream";

      const sender = new ChunkSender(mockSession, body, contentType);

      expect(sender.bodyBuffer).toBe(body);
      expect(sender.contentType).toBe(contentType);
      expect(sender.size).toBe(body.length);
    });

    test("should create ChunkSender with empty body", () => {
      const sender = new ChunkSender(mockSession, null);

      expect(sender.bodyBuffer).toEqual(Buffer.alloc(0));
      expect(sender.contentType).toBeNull();
      expect(sender.disposition).toBeNull();
      expect(sender.size).toBe(0);
    });

    test("should use default content type for string body", () => {
      const sender = new ChunkSender(mockSession, "test");

      expect(sender.contentType).toBe("text/plain");
    });

    test("should use default content type for empty string", () => {
      const sender = new ChunkSender(mockSession, "test", "");

      // Empty string is falsy, so defaults to 'text/plain'
      expect(sender.contentType).toBe("text/plain");
    });

    test("should disable reports when configured", () => {
      msrpSdk.Config.requestReports = false;

      const sender = new ChunkSender(mockSession, "test");

      expect(sender.requestReports).toBe(false);
    });

    test("should override report setting with parameter", () => {
      const sender = new ChunkSender(
        mockSession,
        "test",
        "text/plain",
        null,
        null,
        false
      );

      expect(sender.requestReports).toBe(false);
    });

    test("should throw error for missing session", () => {
      expect(() => {
        new ChunkSender(null, "test");
      }).toThrow("Missing mandatory parameter");
    });

    test("should throw error for unsupported body type", () => {
      expect(() => {
        new ChunkSender(mockSession, 123);
      }).toThrow("Body has unexpected type:");
    });

    test("should handle disposition and description", () => {
      const sender = new ChunkSender(
        mockSession,
        "test",
        "text/plain",
        "attachment",
        "Test file"
      );

      expect(sender.disposition).toBe("attachment");
      expect(sender.description).toBe("Test file");
    });
  });

  describe("getNextChunk", () => {
    test("should create first chunk with headers", () => {
      const body = "Hello World";
      const sender = new ChunkSender(
        mockSession,
        body,
        "text/plain",
        "inline",
        "Test message"
      );

      const chunk = sender.getNextChunk();

      expect(msrpSdk.Message.OutgoingRequest).toHaveBeenCalledWith(
        mockSession,
        "SEND"
      );
      expect(chunk.tid).toBe("test-tid-123");
      expect(chunk.sender).toBe(sender);
      expect(chunk.addHeader).toHaveBeenCalledWith(
        "message-id",
        "test-mid-456"
      );
      expect(chunk.addHeader).toHaveBeenCalledWith("success-report", "yes");
      expect(chunk.addHeader).toHaveBeenCalledWith("failure-report", "yes");
      expect(chunk.addHeader).toHaveBeenCalledWith(
        "content-disposition",
        "inline"
      );
      expect(chunk.addHeader).toHaveBeenCalledWith(
        "content-description",
        "Test message"
      );
      expect(chunk.contentType).toBe("text/plain");
      expect(chunk.body).toBe(body);
      expect(chunk.byteRange).toEqual({
        start: 1,
        end: body.length,
        total: body.length,
      });
      expect(chunk.continuationFlag).toBe(msrpSdk.Message.Flag.end);
      expect(sender.sentBytes).toBe(body.length);
    });

    test("should create chunk without reports when disabled", () => {
      const sender = new ChunkSender(
        mockSession,
        "test",
        "text/plain",
        null,
        null,
        false
      );

      const chunk = sender.getNextChunk();

      expect(chunk.addHeader).toHaveBeenCalledWith("success-report", "no");
      expect(chunk.addHeader).toHaveBeenCalledWith("failure-report", "no");
    });

    test("should create chunk with default inline disposition", () => {
      const sender = new ChunkSender(mockSession, "test");

      const chunk = sender.getNextChunk();

      expect(chunk.addHeader).toHaveBeenCalledWith(
        "content-disposition",
        "inline"
      );
    });

    test("should create chunked message for large body", () => {
      // Create a body larger than 2048 bytes
      const body = "A".repeat(3000);
      const sender = new ChunkSender(mockSession, body);

      const chunk1 = sender.getNextChunk();

      expect(chunk1.byteRange).toEqual({
        start: 1,
        end: 2048,
        total: 3000,
      });
      expect(chunk1.body).toBe("A".repeat(2048));
      expect(chunk1.continuationFlag).toBe(msrpSdk.Message.Flag.continued);
      expect(sender.sentBytes).toBe(2048);

      const chunk2 = sender.getNextChunk();

      expect(chunk2.byteRange).toEqual({
        start: 2049,
        end: 3000,
        total: 3000,
      });
      expect(chunk2.body).toBe("A".repeat(952)); // 3000 - 2048
      expect(chunk2.continuationFlag).toBe(msrpSdk.Message.Flag.end);
      expect(sender.sentBytes).toBe(3000);
    });

    test("should create aborted chunk when aborted", () => {
      const sender = new ChunkSender(mockSession, "test");
      sender.abort();

      const chunk = sender.getNextChunk();

      expect(chunk.continuationFlag).toBe(msrpSdk.Message.Flag.abort);
    });

    test("should create empty chunk for empty body", () => {
      const sender = new ChunkSender(mockSession, null);

      const chunk = sender.getNextChunk();

      // For empty body, body property remains null from Message initialization
      expect(chunk.body).toBe(null);
      expect(chunk.contentType).toBeNull();
      expect(chunk.byteRange).toEqual({
        start: 1,
        end: 0,
        total: 0,
      });
    });

    test("should generate new TID for each chunk", () => {
      let tidCount = 0;
      msrpSdk.Util.newTID.mockImplementation(() => `tid-${++tidCount}`);

      const body = "A".repeat(3000);
      const sender = new ChunkSender(mockSession, body);

      const chunk1 = sender.getNextChunk();
      const chunk2 = sender.getNextChunk();

      expect(chunk1.tid).toBe("tid-1");
      expect(chunk2.tid).toBe("tid-2");
    });

    test("should set up report timeout for final chunk with callback", () => {
      jest.useFakeTimers();
      const onReportTimeout = jest.fn();
      const sender = new ChunkSender(mockSession, "test");
      sender.onReportTimeout = onReportTimeout;

      const chunk = sender.getNextChunk();

      expect(sender.reportTimer).toBeTruthy();

      // Fast-forward time
      jest.advanceTimersByTime(120000);

      expect(onReportTimeout).toHaveBeenCalled();
      expect(sender.reportTimer).toBeNull();

      jest.useRealTimers();
    });
  });

  describe("processReport", () => {
    let sender;
    let mockReport;

    beforeEach(() => {
      sender = new ChunkSender(mockSession, "Hello World");
      sender.sentBytes = 11; // Simulate sent bytes

      mockReport = {
        messageId: "test-mid-456",
        status: msrpSdk.Status.OK,
        byteRange: {
          start: 1,
          end: 11,
          total: 11,
        },
      };
    });

    test("should process successful report", () => {
      sender.processReport(mockReport);

      expect(sender.ackedBytes).toBe(11);
    });

    test("should reject report with wrong message ID", () => {
      mockReport.messageId = "wrong-id";

      sender.processReport(mockReport);

      expect(msrpSdk.Logger.error).toHaveBeenCalledWith(
        "REPORT has wrong message ID!"
      );
      expect(sender.ackedBytes).toBe(0);
    });

    test("should abort on error report", () => {
      mockReport.status = "400";

      sender.processReport(mockReport);

      expect(sender.aborted).toBe(true);
      expect(sender.remoteAbort).toBe(true);
    });

    test("should handle partial report", () => {
      mockReport.byteRange.end = 5;

      sender.processReport(mockReport);

      expect(sender.ackedBytes).toBe(5);
    });

    test("should handle incontiguous reports", () => {
      // First report for bytes 1-5
      mockReport.byteRange.end = 5;
      sender.processReport(mockReport);
      expect(sender.ackedBytes).toBe(5);

      // Second report for bytes 8-11 (gap at 6-7)
      const report2 = {
        messageId: "test-mid-456",
        status: msrpSdk.Status.OK,
        byteRange: { start: 8, end: 11, total: 11 },
      };
      sender.processReport(report2);
      expect(sender.ackedBytes).toBe(5); // Still at 5 due to gap
      expect(sender.incontiguousReports[8]).toBe(11);
      expect(sender.incontiguousReportCount).toBe(1);

      // Third report for bytes 6-7 (fills the gap)
      const report3 = {
        messageId: "test-mid-456",
        status: msrpSdk.Status.OK,
        byteRange: { start: 6, end: 7, total: 11 },
      };
      sender.processReport(report3);
      expect(sender.ackedBytes).toBe(11); // Now complete
      expect(sender.incontiguousReportCount).toBe(0);
    });

    test("should resume on too many incontiguous reports", () => {
      sender.incontiguousReportCount = 17; // Over limit
      const resumeSpy = jest.spyOn(sender, "resume").mockImplementation();

      // Report that would be incontiguous
      mockReport.byteRange.start = 20;
      mockReport.byteRange.end = 25;

      sender.processReport(mockReport);

      expect(resumeSpy).toHaveBeenCalled();
    });

    test("should clear report timer when complete", () => {
      jest.useFakeTimers();
      sender.onReportTimeout = jest.fn();
      sender.getNextChunk(); // This sets up the timer
      expect(sender.reportTimer).toBeTruthy();

      sender.processReport(mockReport);

      expect(sender.reportTimer).toBeNull();
      jest.useRealTimers();
    });
  });

  describe("Status Methods", () => {
    test("isSendComplete should return true when all bytes sent", () => {
      const sender = new ChunkSender(mockSession, "test");
      sender.sentBytes = 4; // 'test'.length

      expect(sender.isSendComplete()).toBe(true);
    });

    test("isSendComplete should return true when aborted", () => {
      const sender = new ChunkSender(mockSession, "test");
      sender.aborted = true;

      expect(sender.isSendComplete()).toBe(true);
    });

    test("isSendComplete should return false when more to send", () => {
      const sender = new ChunkSender(mockSession, "test");
      sender.sentBytes = 2;

      expect(sender.isSendComplete()).toBe(false);
    });

    test("isComplete should return true when all bytes acked", () => {
      const sender = new ChunkSender(mockSession, "test");
      sender.ackedBytes = 4; // 'test'.length

      expect(sender.isComplete()).toBe(true);
    });

    test("isComplete should return true when aborted", () => {
      const sender = new ChunkSender(mockSession, "test");
      sender.aborted = true;

      expect(sender.isComplete()).toBe(true);
    });

    test("isComplete should return false when waiting for acks", () => {
      const sender = new ChunkSender(mockSession, "test");
      sender.sentBytes = 4;
      sender.ackedBytes = 2;

      expect(sender.isComplete()).toBe(false);
    });
  });

  describe("Control Methods", () => {
    test("resume should reset state for retry", () => {
      const sender = new ChunkSender(mockSession, "test");
      sender.sentBytes = 10;
      sender.ackedBytes = 5;
      sender.incontiguousReports = { 8: 10 };
      sender.incontiguousReportCount = 1;

      sender.resume();

      expect(sender.sentBytes).toBe(5);
      expect(sender.incontiguousReports).toEqual({});
      expect(sender.incontiguousReportCount).toBe(0);
      expect(msrpSdk.Logger.info).toHaveBeenCalledWith("Resuming at offset 5");
    });

    test("abort should set aborted flag", () => {
      const sender = new ChunkSender(mockSession, "test");

      sender.abort();

      expect(sender.aborted).toBe(true);
    });

    test("abort should trigger immediate report timeout", () => {
      jest.useFakeTimers();
      const onReportTimeout = jest.fn();
      const sender = new ChunkSender(mockSession, "test");
      sender.onReportTimeout = onReportTimeout;
      sender.getNextChunk(); // Sets up timer

      sender.abort();

      expect(sender.reportTimer).toBeTruthy();

      // Advance to trigger immediate timeout
      jest.advanceTimersByTime(1);

      expect(onReportTimeout).toHaveBeenCalled();
      expect(sender.reportTimer).toBeNull();

      jest.useRealTimers();
    });

    test("abort should clear existing timer and set immediate timeout", () => {
      jest.useFakeTimers();
      const onReportTimeout = jest.fn();
      const sender = new ChunkSender(mockSession, "test");
      sender.onReportTimeout = onReportTimeout;
      sender.getNextChunk(); // Sets up 120s timer

      const originalTimer = sender.reportTimer;
      sender.abort();

      // Should have cleared the original timer and set new immediate one
      expect(sender.reportTimer).not.toBe(originalTimer);

      jest.useRealTimers();
    });
  });

  describe("Edge Cases", () => {
    test("should handle zero-length body", () => {
      const sender = new ChunkSender(mockSession, "");

      const chunk = sender.getNextChunk();

      expect(chunk.body).toBe(null);
      expect(sender.size).toBe(0);
      expect(sender.sentBytes).toBe(0);
    });

    test("should handle exactly chunk-sized body", () => {
      const body = "A".repeat(2048);
      const sender = new ChunkSender(mockSession, body);

      const chunk = sender.getNextChunk();

      expect(chunk.byteRange.end).toBe(2048);
      expect(chunk.continuationFlag).toBe(msrpSdk.Message.Flag.end);
    });

    test("should handle body slightly larger than chunk size", () => {
      const body = "A".repeat(2049);
      const sender = new ChunkSender(mockSession, body);

      const chunk1 = sender.getNextChunk();
      expect(chunk1.continuationFlag).toBe(msrpSdk.Message.Flag.continued);

      const chunk2 = sender.getNextChunk();
      expect(chunk2.body).toBe("A");
      expect(chunk2.continuationFlag).toBe(msrpSdk.Message.Flag.end);
    });

    test("should handle report for already completed range", () => {
      const sender = new ChunkSender(mockSession, "test");
      sender.ackedBytes = 4;

      const mockReport = {
        messageId: "test-mid-456",
        status: msrpSdk.Status.OK,
        byteRange: { start: 1, end: 3, total: 4 },
      };

      sender.processReport(mockReport);

      expect(sender.ackedBytes).toBe(4); // Should remain unchanged
    });
  });
});
