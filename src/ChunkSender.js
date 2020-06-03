'use strict';

const { StringDecoder } = require('string_decoder');

// eslint-disable-next-line max-lines-per-function
module.exports = function (MsrpSdk) {

  const CHUNK_SIZE = 2048;
  const REPORT_TIMEOUT = 30000; // Wait for 30 seconds to receive the Success/Failure report

  /**
   * Manages the sending of a message, dividing it into chunks if required.
   */
  class ChunkSender {
  /**
   * Creates a new ChunkSender instance to handle an outgoing message.
   *
   * @param {object} routePaths The message paths.
   * @param {Array} routePaths.toPath The To-Path uris.
   * @param {Array} routePaths.fromPath The From-Path uri.
   * @param {object} [message] The message data
   * @param {String|Buffer} [message.body] The body of the message to send. If not set, an empty SEND message is sent.
   * @param {string} [message.contentType] The MIME type of the message. Default is text/plain.
   * @param {string} [message.disposition] The disposition of the message. Default is inline.
   * @param {string} [message.description] The description of the message.
   * @param {Function} [onReportReceived] Callback function invoked when report is received (or times out).
   */
    constructor(routePaths, message = {}, onReportReceived = null) {
      if (!routePaths || !message) {
        throw new TypeError('Missing mandatory parameter: session');
      }

      const { body = '', contentType, disposition, description } = message;

      this.routePaths = routePaths;
      this.blob = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      this.contentType = contentType || 'text/plain';
      this.disposition = disposition;
      this.description = description;

      this.onReportReceived = onReportReceived;

      this.nextTid = MsrpSdk.Util.newTID();
      this.messageId = MsrpSdk.Util.newMID();

      this.size = this.blob.length;

      // The highest byte index sent so far
      this.sentBytes = 0;
      // The number of contiguous acked bytes
      this.ackedBytes = 0;
      // Array containing REPORT acks that arrive out-of-order
      this.incontiguousRanges = [];

      // Report timer reference
      this.reportTimer = null;

      this.aborted = false;
      this.remoteAbort = false;
      this.finished = false;

      // The current position in the blob
      this.seek = 0;
      // StringDecoder instance used in case message needs to be chunked
      this.decoder = null;
    }

    _handleFinalReport(status) {
      this.finished = true;
      this.incontiguousRanges = null;

      if (this.reportTimer) {
        clearTimeout(this.reportTimer);
        this.reportTimer = null;
      }

      if (status === MsrpSdk.Status.OK) {
        MsrpSdk.Logger.debug(`Received Success Report(s) for messageId ${this.messageId}`);
      } else {
        MsrpSdk.Logger.warn(`Receive Failure Report with status ${status} for messageId ${this.messageId}`);
      }

      if (typeof this.onReportReceived === 'function') {
        try {
          this.onReportReceived(status, this.messageId);
        } catch (err) {
          MsrpSdk.Logger.error('Error in onReportReceived handler.', err);
        }
        this.onReportReceived = null;
      }
    }

    getNextChunk() {
      const chunk = new MsrpSdk.Message.OutgoingRequest(this.routePaths, 'SEND', this.nextTid);
      this.nextTid = MsrpSdk.Util.newTID();

      chunk.sender = this;
      chunk.addHeader('Message-ID', this.messageId);
      chunk.addHeader('Success-Report', 'yes');
      chunk.addHeader('Failure-Report', 'yes');
      if (this.aborted) {
        chunk.continuationFlag = MsrpSdk.Message.Flag.abort;
        return chunk;
      }

      // RFC-4975: There are some circumstances where an endpoint may choose to send an
      // empty SEND request. For the sake of consistency, a Byte-Range header
      // field referring to nonexistent or zero-length content MUST still have
      // a range-start value of 1.  For example, "1-0/0"
      const start = this.sentBytes + 1;
      let end = 0;

      if (this.size > 0) {
        if (this.sentBytes === 0) {
          // Include extra MIME headers on first chunk
          chunk.addHeader('Content-Disposition', this.disposition || 'inline');
          if (this.description) {
            chunk.addHeader('Content-Description', this.description);
          }
        }
        chunk.contentType = this.contentType;
        if (this.size < CHUNK_SIZE) {
          chunk.body = this.blob.toString('utf8');
          end = this.size;
        } else {
          // We need to split the message in chunks. Use StringDecoder to ensure we send full UTF-8 characters.
          if (!this.decoder) {
            this.decoder = new StringDecoder('utf8');
          }
          chunk.body = this.decoder.write(this.blob.slice(this.seek, this.seek + CHUNK_SIZE));
          this.seek += CHUNK_SIZE;
          end = this.sentBytes + Buffer.byteLength(chunk.body, 'utf8');
        }
      }

      chunk.byteRange = {
        start,
        end,
        total: this.size
      };

      if (end < this.size) {
        chunk.continuationFlag = MsrpSdk.Message.Flag.continued;
      } else {
        // This is the last chunk. Start timer to wait for Success/Failure report.
        const sender = this;
        this.reportTimer = setTimeout(() => {
          sender.reportTimer = null;
          MsrpSdk.Logger.warn(`Timed out waiting for Success/Failure Report for ${this.messageId}`);
          sender._handleFinalReport(MsrpSdk.Status.REQUEST_TIMEOUT);
        }, REPORT_TIMEOUT);
      }
      this.sentBytes = end;
      return chunk;
    }

    /**
     * Processes report(s) for the message as they arrive.
     * @param {object} report The received report for this sender.
     */
    processReport(report) {
      if (this.finished) {
        MsrpSdk.Logger.debug(`Sender for ${this.messageId} has already finished processing reports`);
        return;
      }
      if (report.messageId !== this.messageId) {
        MsrpSdk.Logger.error(`REPORT has wrong message ID - Message:${this.messageId}, Report:${report.messageId}`);
        return;
      }

      if (report.status !== MsrpSdk.Status.OK) {
        // Received Failure Report
        this.aborted = true;
        this.remoteAbort = true;
        this._handleFinalReport(report.status);
        return;
      }

      // Success Report. Check the byte range.
      if (report.byteRange.start > this.ackedBytes + 1) {
        // This is an incontiguous report
        const inserted = this.incontiguousRanges.some((range, idx) => {
          if (report.byteRange.start <= range.start) {
            this.incontiguousRanges.splice(idx, 0, report.byteRange);
            return true;
          }
          return false;
        });
        if (!inserted) {
          // Add to the end
          this.incontiguousRanges.push(report.byteRange);
        }
        return;
      }

      if (report.byteRange.end > this.ackedBytes) {
        this.ackedBytes = report.byteRange.end;
      }

      const incontiguousIdx = this.incontiguousRanges.findIndex(range => {
        if (range.start > this.ackedBytes + 1) {
          // This is the first incontiguous range
          return true;
        }
        if (range.end > this.ackedBytes) {
          this.ackedBytes = range.end;
        }
        return false;
      });
      if (incontiguousIdx === -1) {
        // There are no more incontiguous entries
        this.incontiguousRanges = [];
      } else if (incontiguousIdx > 0) {
        // Remove processed ranges
        this.incontiguousRanges.splice(0, incontiguousIdx);
      }

      if (this.isComplete()) {
        this._handleFinalReport(MsrpSdk.Status.OK);
      }
    }

    /**
     * Checks whether all chunks have been sent.
     * @returns {boolean} True if all chunks have been sent, or if the
     * message has been aborted. False if there are further chunks to be sent.
     */
    isSendComplete() {
      return this.aborted || (this.sentBytes >= this.size);
    }

    /**
     * Checks whether all chunks have been sent and acked.
     * @returns {boolean} True if all chunks have been sent and acked, or if the
     * message has been aborted. False if there are further chunks to be sent,
     * or if there are acks outstanding.
     */
    isComplete() {
      return this.aborted || (this.ackedBytes >= this.size);
    }

    /**
     * Requests that we abort this outgoing chunked message. The next chunk will include the abort flag.
     */
    abort() {
      this.aborted = true;
    }
  }

  MsrpSdk.ChunkSender = ChunkSender;
};
