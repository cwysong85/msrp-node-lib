module.exports = function(MsrpSdk) {
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
  var ChunkSender = function(session, body, contentType, disposition, description, requestReports = MsrpSdk.Config.requestReports === false ? false : true) {
    if (!session) {
      throw new TypeError('Missing mandatory parameter');
    }
    if (!body) {
      this.bodyBuffer = Buffer.alloc(0);
      this.contentType = null;
      this.disposition = null;
    } else if (body instanceof String || typeof body === 'string') {
      this.bodyBuffer = Buffer.from(body);
      this.contentType = contentType || 'text/plain';
      this.disposition = disposition;
    } else if (Buffer.isBuffer(body)) {
      this.bodyBuffer = body;
      // we are only supporting text/plain in this lib currently
      this.contentType = contentType || 'text/plain';
      this.disposition = disposition;
    } else {
      throw new TypeError('Body has unexpected type:', body);
    }

    this.session = session;
    this.nextTid = MsrpSdk.Util.newTID();
    this.messageId = MsrpSdk.Util.newMID();
    if (this.contentType === '') {
      // We have to put something here...
      this.contentType = 'application/octet-stream';
    }
    this.description = description;

    // Get the size of the buffer
    this.size = this.bodyBuffer.length;
    // The highest byte index sent so far
    this.sentBytes = 0;
    // The number of contiguous acked bytes
    this.ackedBytes = 0;
    // Map containing REPORT acks that arrive out-of-order (indexed by range start)
    this.incontiguousReports = {};
    this.incontiguousReportCount = 0;
    // Request reports for sent MSRP messages
    this.requestReports = requestReports;
    // Report timer reference
    this.reportTimer = null;
    // Optional report timeout callback
    this.onReportTimeout = null;
    this.aborted = false;
    this.remoteAbort = false;
  };
  ChunkSender.prototype.getNextChunk = function() {
    var chunk;
    chunk = new MsrpSdk.Message.OutgoingRequest(this.session, 'SEND');
    chunk.sender = this;
    chunk.tid = this.nextTid;
    this.nextTid = MsrpSdk.Util.newTID();
    chunk.addHeader('message-id', this.messageId);
    chunk.addHeader('success-report', this.requestReports ? 'yes' : 'no');
    chunk.addHeader('failure-report', this.requestReports ? 'yes' : 'no');
    if (this.aborted) {
      chunk.continuationFlag = MsrpSdk.Message.Flag.abort;
    } else {
      var start = this.sentBytes + 1,
        end = Math.min(this.sentBytes + 2048, this.size);
      chunk.byteRange = {
        'start': start,
        'end': end,
        'total': this.size
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
        var body = this.bodyBuffer.slice(this.sentBytes, end);
        chunk.body = body.toString('utf8', 0, body.length);
      }
      if (end < this.size) {
        chunk.continuationFlag = MsrpSdk.Message.Flag.continued;
      } else if (this.onReportTimeout) {
        var sender = this;
        this.reportTimer = setTimeout(function() {
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
  ChunkSender.prototype.processReport = function(report) {
    var start, appended = true;
    if (report.messageId !== this.messageId) {
      MsrpSdk.Logger.error('REPORT has wrong message ID!');
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
    return;
  };
  /**
   * Checks whether all chunks have been sent.
   * @returns {Boolean} True if all chunks have been sent, or if the
   * message has been aborted. False if there are further chunks to be sent.
   * @private
   */
  ChunkSender.prototype.isSendComplete = function() {
    return this.aborted || (this.sentBytes >= this.size);
  };
  /**
   * Checks whether all chunks have been sent and acked.
   * @returns {Boolean} True if all chunks have been sent and acked, or if the
   * message has been aborted. False if there are further chunks to be sent,
   * or if there are acks outstanding.
   * @private
   */
  ChunkSender.prototype.isComplete = function() {
    return this.aborted || (this.ackedBytes >= this.size);
  };
  /**
   * Resumes a transfer after the connection has been lost. Rewind the sent
   * bytes to match the acknowledged position (according to received REPORTs).
   * @private
   */
  ChunkSender.prototype.resume = function() {
    this.sentBytes = this.ackedBytes;
    this.incontiguousReports = {};
    this.incontiguousReportCount = 0;
    MsrpSdk.Logger.info('Resuming at offset ' + this.sentBytes);
  };
  /**
   * Requests that we abort this outgoing chunked message. The next chunk will
   * include the abort flag.
   * @private
   */
  ChunkSender.prototype.abort = function() {
    this.aborted = true;
    if (this.reportTimer) {
      // Treat this as an immediate report timeout
      clearTimeout(this.reportTimer);
      var sender = this;
      this.reportTimer = setTimeout(function() {
        sender.onReportTimeout();
        sender.reportTimer = null;
      }, 0);
    }
  };
  function toArrayBuffer(buffer) {
    var ab = new ArrayBuffer(buffer.length);
    var view = new Uint8Array(ab);
    for (var i = 0; i < buffer.length; ++i) {
      view[i] = buffer[i];
    }
    return ab;
  }
  MsrpSdk.ChunkSender = ChunkSender;
};