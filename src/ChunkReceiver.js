'use strict';

// eslint-disable-next-line max-lines-per-function
module.exports = function (MsrpSdk) {

  const MAX_SIZE = 1024 * 1024; // Max message size (1 MB)

  /**
   * Tracks and combines the received components of a chunked message.
   */
  class ChunkReceiver {
    /**
     * Creates a new ChunkReceiver object to handle an incoming chunked message.
     *
     * @param {string} messageId - The Message-ID value.
     */
    constructor(messageId) {
      this.messageId = messageId;
      this.totalBytes = -1;
      this.bufferedChunks = [];
      this.bufferedBytes = 0;

      this.lastReceive = 0;
      this.isFile = false;

      // buffer contains all the contiguous message bodies we have received
      this.buffer = null;
      // Current buffer size; cached since buffer.length seems to be slow
      this.size = 0;

      // receivedBytes may be > totalBytes if we've had duplicate chunks
      this.receivedBytes = 0;
      this.aborted = false; // true if the transfer has been aborted
      this.remoteAbort = false; // true if the remote end aborted
      this.incontiguousChunks = null;
    }

    _writeToBuffer() {
      if (this.size > 0) {
        this.bufferedChunks.unshift(this.buffer);
      }

      this.buffer = Buffer.concat(this.bufferedChunks);
      this.size = this.buffer.length;
      this.bufferedChunks = [];
      this.bufferedBytes = 0;
    }

    /**
     * Processes subsequent chunks of the message as they arrive.
     *
     * @param {Message.Request} chunk - The received chunk.
     * This must be a chunk of the same message (i.e. the Message-ID must match that of the first chunk).
     * @returns {Boolean} True if the chunk was successfully handled, false if the transfer should be aborted.
     */
    processChunk(chunk) {
      if (!chunk || !chunk.byteRange) {
        MsrpSdk.Logger.error('Chunk is missing the required Byte-Range header');
        return false;
      }

      if (chunk.messageId !== this.messageId) {
        MsrpSdk.Logger.error(`Chunk has wrong messageId - Expected:${this.messageId}, Chunk:${chunk.messageId}`);
        return false;
      }

      if (this.aborted) {
        // The message has been aborted locally, or we've received another
        // chunk of a remote-aborted message; return error.
        MsrpSdk.Logger.warn(`Receiver for ${this.messageId} has already been aborted`);
        return false;
      }

      if (chunk.byteRange.start === 1) {
        // This is the first chunk
        this.isFile = !!chunk.contentDisposition &&
          (chunk.contentDisposition.type === 'attachment' || chunk.contentDisposition.type === 'render');
      }

      // totalBytes may be -1 if we don't know the size
      if (chunk.byteRange.total > 0) {
        this.totalBytes = chunk.byteRange.total;

        if (this.totalBytes > MAX_SIZE) {
          MsrpSdk.Logger.error(`Message totalBytes (${this.totalBytes}) exceeds max allowed buffer size (${MAX_SIZE})`);
          this.abort();
          return false;
        }
      }

      let nextStart = this.size + this.bufferedBytes + 1;

      this.lastReceive = Date.now();

      const chunkBody = Buffer.from(chunk.body || '', 'utf8');
      const chunkSize = chunkBody.length;

      this.receivedBytes += chunkSize;

      switch (chunk.continuationFlag) {
        case MsrpSdk.Message.Flag.continued:
          break;
        case MsrpSdk.Message.Flag.end:
          this.totalBytes = chunk.byteRange.start + chunkSize - 1;
          break;
        case MsrpSdk.Message.Flag.abort:
          this.abort();
          this.remoteAbort = true;
          return false;
      }

      if (chunk.byteRange.start === nextStart) {
        // This is the expected result; append to the write buffer
        this.bufferedChunks.push(chunkBody);
        this.bufferedBytes += chunkSize;
        nextStart += chunkSize;

        // Check whether there are any incontiguous chunks we can now append
        if (this.incontiguousChunks) {
          let nextChunk = this.incontiguousChunks.get(nextStart);
          while (nextChunk) {
            this.incontiguousChunks.delete(nextStart);
            this.bufferedChunks.push(nextChunk);
            const size = nextChunk.length;
            this.bufferedBytes += size;
            nextStart += size;

            // See if there are more chunks
            nextChunk = this.incontiguousChunks.get(nextStart);
          }
        }

        if (this.bufferedBytes > MAX_SIZE) {
          MsrpSdk.Logger.error(`Buffered bytes has exceeded max allowed buffer size: ${MAX_SIZE}`);
          this.abort();
          return false;
        }

        // Write out to the blob if the transfer is complete
        if (this.size + this.bufferedBytes === this.totalBytes) {
          this._writeToBuffer();
          this.incontiguousChunks = null;
        }

      } else if (chunk.byteRange.start > nextStart) {
        // Add this chunk to the map of incontiguous chunks
        if (!this.incontiguousChunks) {
          this.incontiguousChunks = new Map();
        }
        this.incontiguousChunks.set(chunk.byteRange.start, chunkBody);
      } else {
        MsrpSdk.Logger.warn(`[SocketHandler]: Received duplicate chunk for messageId: ${this.messageId}`);

        // Duplicate chunk: RFC 4975 section 7.3.1 paragraph 3 suggests
        // that the last chunk received SHOULD take precedence.
        const chunks = [];

        // Write out the buffer in case the new chunk overlaps
        this._writeToBuffer();

        // Construct a new blob from this chunk plus appropriate slices of the existing blob.
        if (chunk.byteRange.start > 1) {
          chunks.push(this.buffer.slice(0, chunk.byteRange.start - 1));
        }
        chunks.push(chunkBody);
        if (chunk.byteRange.start + chunkSize <= this.size) {
          chunks.push(this.buffer.slice(chunk.byteRange.start + chunkSize - 1));
        }

        this.buffer = Buffer.concat(chunks);
        this.size = this.buffer.length;
      }

      if (this.size === this.totalBytes) {
        MsrpSdk.Logger.debug(`[SocketHandler]: Received all chunks for messageId: ${this.messageId}`);
      } else {
        MsrpSdk.Logger.debug(`[SocketHandler]: Waiting for additional chunks for messageId: ${this.messageId}. Received bytes: ${this.receivedBytes}`);
      }
      return true;
    }

    /**
     * Checks whether all expected chunks have been received.
     *
     * @returns {Boolean} True if all chunks have been received, or if the
     * message has been aborted. False if we still expect further chunks.
     */
    isComplete() {
      return this.aborted || (this.size === this.totalBytes);
    }

    /**
     * Requests that we abort this incoming chunked message. An appropriate
     * error will be returned when we receive the next chunk.
     */
    abort() {
      this.aborted = true;
      this.buffer = null;
      this.size = 0;
      this.bufferedChunks = [];
      this.bufferedBytes = 0;
      this.incontiguousChunks = null;
    }
  }

  MsrpSdk.ChunkReceiver = ChunkReceiver;
};
