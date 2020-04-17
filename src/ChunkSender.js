'use strict';

// eslint-disable-next-line max-lines-per-function
module.exports = function (MsrpSdk) {
  /**
   * Creates a new ChunkSender object to handle an outgoing message.
   * @class Manages the sending of a message, dividing it into chunks
   * if required.
   * @param {CrocMSRP.Session} session The session sending the message.
   * @param {String|ArrayBuffer|ArrayBufferView|Blob|File} [body] The body of
   * the message to send. If this is null or undefined then an empty SEND
   * message will be sent.
   * @param {String} [contentType] The MIME type of the message.
   * @param {String} [disposition] The disposition of the message (defaults to
   * 'inline' if not provided, or 'attachment' if the body is a File object).
   * @param {String} [description] The description of the message. This would
   * normally only be used when sending a file.
   * @private
   */
  const ChunkSender = function (session, body, contentType, disposition, description) {
    if (!session) {
      throw new TypeError('Missing mandatory parameter');
    }
    this.blob = body;
    this.contentType = contentType || 'text/plain';
    this.disposition = disposition;
    this.session = session;
    this.nextTid = MsrpSdk.Util.newTID();
    this.messageId = MsrpSdk.Util.newMID();
    if (this.contentType === '') {
      // We have to put something here...
      this.contentType = 'application/octet-stream';
    }
    this.description = description;
    // this.size = this.blob.length;
    this.size = MsrpSdk.Util.byteLength(this.blob);
    // The highest byte index sent so far
    this.sentBytes = 0;
    // The number of contiguous acked bytes
    this.ackedBytes = 0;
    // Map containing REPORT acks that arrive out-of-order (indexed by range start)
    this.incontiguousReports = {};
    this.incontiguousReportCount = 0;
    // Report timer reference
    this.reportTimer = null;
    // Optional report timeout callback
    this.onReportTimeout = null;
    this.aborted = false;
    this.remoteAbort = false;
  };
  ChunkSender.prototype.getNextChunk = function () {
    const chunk = new MsrpSdk.Message.OutgoingRequest(this.session, 'SEND');
    chunk.sender = this;
    chunk.tid = this.nextTid;
    this.nextTid = MsrpSdk.Util.newTID();
    chunk.addHeader('message-id', this.messageId);
    chunk.addHeader('success-report', 'yes');
    chunk.addHeader('failure-report', 'yes');
    if (this.aborted) {
      chunk.continuationFlag = MsrpSdk.Message.Flag.abort;
    } else {
      const start = this.sentBytes + 1;
      const end = Math.min(this.sentBytes + 2048, this.size);

      chunk.byteRange = {
        start,
        end,
        total: this.size
      };

      if (this.size > 0) {
        if (this.sentBytes === 0) {
          // Include extra MIME headers on first chunk
          if (this.disposition) {
            chunk.addHeader('content-disposition', this.disposition);
          } else {
            chunk.addHeader('content-disposition', 'inline');
          }
          if (this.description) {
            chunk.addHeader('content-description', this.description);
          }
        }
        chunk.contentType = this.contentType;
        chunk.body = this.blob.slice(this.sentBytes, end);
      }
      if (end < this.size) {
        chunk.continuationFlag = MsrpSdk.Message.Flag.continued;
      } else if (this.onReportTimeout) {
        const sender = this;
        this.reportTimer = setTimeout(() => {
          sender.onReportTimeout();
          sender.reportTimer = null;
        }, 120000);
      }
      this.sentBytes = end;
    }
    return chunk;
  };
  /**
   * Processes report(s) for the message as they arrive.
   * @param {CrocMSRP.Message.Request} report The received report.  This must
   * be a report for a message sent by this object (i.e. the Message-ID must
   * match).
   * @private
   */
  ChunkSender.prototype.processReport = function (report) {
    let start, appended = true;
    if (report.messageId !== this.messageId) {
      MsrpSdk.Logger.error(`REPORT has wrong message ID - Message:${this.messageId}, Report:${report.messageId}`);
      return;
    }
    if (report.status !== MsrpSdk.Status.OK) {
      this.abort();
      this.remoteAbort = true;
    } else {
      // Success report; check the byte range
      if (report.byteRange.start <= this.ackedBytes + 1) {
        if (report.byteRange.end > this.ackedBytes) {
          this.ackedBytes = report.byteRange.end;
        }
      } else if (this.incontiguousReportCount > 16) {
        // Start resending from the last acked position
        this.resume();
        return;
      } else {
        // Add this report to the map of incontiguous reports
        this.incontiguousReports[report.byteRange.start] = report.byteRange.end;
        this.incontiguousReportCount++;
        return;
      }
      // Check whether any previous reports are now contiguous
      while (appended) {
        appended = false;
        for (start in this.incontiguousReports) {
          if (start <= this.ackedBytes + 1) {
            if (this.incontiguousReports[start] > this.ackedBytes) {
              this.ackedBytes = this.incontiguousReports[start];
            }
            delete this.incontiguousReports[start];
            this.incontiguousReportCount--;
            appended = true;
          }
        }
      }
    }
    if (this.isComplete() && this.reportTimer) {
      clearTimeout(this.reportTimer);
      this.reportTimer = null;
    }
  };

  /**
   * Checks whether all chunks have been sent.
   * @returns {Boolean} True if all chunks have been sent, or if the
   * message has been aborted. False if there are further chunks to be sent.
   * @private
   */
  ChunkSender.prototype.isSendComplete = function () {
    return this.aborted || (this.sentBytes >= this.size);
  };

  /**
   * Checks whether all chunks have been sent and acked.
   * @returns {Boolean} True if all chunks have been sent and acked, or if the
   * message has been aborted. False if there are further chunks to be sent,
   * or if there are acks outstanding.
   * @private
   */
  ChunkSender.prototype.isComplete = function () {
    return this.aborted || (this.ackedBytes >= this.size);
  };

  /**
   * Resumes a transfer after the connection has been lost. Rewind the sent
   * bytes to match the acknowledged position (according to received REPORTs).
   * @private
   */
  ChunkSender.prototype.resume = function () {
    this.sentBytes = this.ackedBytes;
    this.incontiguousReports = {};
    this.incontiguousReportCount = 0;
    MsrpSdk.Logger.info(`Resuming at offset ${this.sentBytes}`);
  };

  /**
   * Requests that we abort this outgoing chunked message. The next chunk will
   * include the abort flag.
   * @private
   */
  ChunkSender.prototype.abort = function () {
    this.aborted = true;
    if (this.reportTimer) {
      // Treat this as an immediate report timeout
      clearTimeout(this.reportTimer);
      const sender = this;
      this.reportTimer = setTimeout(() => {
        sender.onReportTimeout();
        sender.reportTimer = null;
      }, 0);
    }
  };

  MsrpSdk.ChunkSender = ChunkSender;
};
