module.exports = function(MsrpSdk) {

  /**
   * Creates a new ChunkReceiver object to handle an incoming chunked message.
   * @class Tracks and combines the received components of a chunked message.
   * @param {CrocMSRP.Message.Request} firstChunk The first received chunk:
   * this must contain the first byte of the incoming message. Later chunks
   * may arrive out-of-order.
   * @param {Number} bufferSize The threshold of data to cache in memory
   * writing the chunks out to a Buffer (which will generally get stored to
   * disk).
   * @private
   */
  var ChunkReceiver = function(firstChunk, bufferSize) {
    if (!firstChunk || !firstChunk instanceof MsrpSdk.Message.Request) {
      throw new TypeError('Missing or unexpected parameter');
    }

    this.firstChunk = firstChunk;

    // totalBytes may be -1 if we don't know the size
    this.totalBytes = firstChunk.byteRange.total;
    this.bufferedChunks = [];
    this.bufferedBytes = 0;
    this.bufferSize = bufferSize;
    // buffer contains all the contiguous message bodies we have received
    this.buffer = null;
    // Current buffer size; cached since buffer.length seems to be slow
    this.size = 0;
    // receivedBytes may be > totalBytes if we've had duplicate chunks
    this.receivedBytes = 0;
    this.aborted = false; // true if the transfer has been aborted
    this.remoteAbort = false; // true if the remote end aborted
    this.incontiguousChunks = {};
    this.isFile = firstChunk.contentDisposition &&
      (firstChunk.contentDisposition.type === 'attachment' ||
        firstChunk.contentDisposition.type === 'render');
    this.processChunk(firstChunk);
  };

  /**
   * Processes subsequent chunks of the message as they arrive.
   * @param {CrocMSRP.Message.Request} chunk The received chunk. This must be
   * a chunk of the same message (i.e. the Message-ID must match that of the
   * first chunk).
   * @returns {Boolean} True if the chunk was successfully handled, false
   * if the transfer should be aborted.
   * @private
   */
  ChunkReceiver.prototype.processChunk = function(chunk) {
    var chunkBody, chunkSize,
      nextStart = this.size + this.bufferedBytes + 1;

    if (this.aborted) {
      // The message has been aborted locally, or we've received another
      // chunk of a remote-aborted message; return error.
      return false;
    }

    if (chunk.messageId !== this.firstChunk.messageId) {
      MsrpSdk.Logger.error('Chunk has wrong message ID!');
      return false;
    }

    this.lastReceive = new Date().getTime();

    if (chunk.body instanceof ArrayBuffer) {
      // Yay! Binary frame, everything is straightforward.
      // Convert to ArrayBufferView to avoid Chrome Blob constructor warning
      // This should not be necessary: https://bugs.webkit.org/show_bug.cgi?id=88389
      chunkBody = new Uint8Array(chunk.body);
      chunkSize = chunkBody.byteLength;
    } else {
      // Boo. Text frame: turn it back into UTF-8 and cross your fingers
      // that the resulting bytes are what they should be.
      chunkBody = Buffer.from(chunk.body ?? '');
      chunkSize = chunkBody.length;
    }

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
      while (!MsrpSdk.Util.isEmpty(this.incontiguousChunks)) {
        var nextChunk = this.incontiguousChunks[nextStart];
        if (!nextChunk) {
          // There's a gap: stop appending
          break;
        }
        delete this.incontiguousChunks[nextStart];

        // Add it to the disk buffer
        this.bufferedChunks.push(nextChunk);
        if (nextChunk instanceof ArrayBuffer) {
          chunkSize = nextChunk.byteLength;
        } else {
          chunkSize = nextChunk.length;
        }
        this.bufferedBytes += chunkSize;
        nextStart += chunkSize;
      }

      // Write out to the blob if we've exceeded the buffer size, or the
      // transfer is complete
      if (this.bufferedBytes >= this.bufferSize || this.size + this.bufferedBytes === this.totalBytes) {
        writeToBuffer(this);
      }

    } else if (chunk.byteRange.start > nextStart) {
      // Add this chunk to the map of incontiguous chunks
      this.incontiguousChunks[chunk.byteRange.start] = chunkBody;
    } else {
      // Duplicate chunk: RFC 4975 section 7.3.1 paragraph 3 suggests
      // that the last chunk received SHOULD take precedence.
      var array = [];

      // Write out the buffer in case the new chunk overlaps
      writeToBuffer(this);

      // Construct a new blob from this chunk plus appropriate slices
      // of the existing blob.
      if (chunk.byteRange.start > 1) {
        array.push(this.buffer.slice(0, chunk.byteRange.start - 1));
      }
      array.push(chunkBody);
      if (chunk.byteRange.start + chunkSize <= this.size) {
        array.push(this.buffer.slice(chunk.byteRange.start + chunkSize - 1));
      }

      this.buffer = Buffer.from(array);
      this.size = this.buffer.length;
    }

    return true;
  };

  /**
   * Checks whether all expected chunks have been received.
   * @returns {Boolean} True if all chunks have been received, or if the
   * message has been aborted. False if we still expect further chunks.
   * @private
   */
  ChunkReceiver.prototype.isComplete = function() {
    return this.aborted || (this.size === this.totalBytes);
  };

  /**
   * Requests that we abort this incoming chunked message. An appropriate
   * error will be returned when we receive the next chunk.
   * @private
   */
  ChunkReceiver.prototype.abort = function() {
    this.aborted = true;
  };

  function writeToBuffer(receiver) {
    if (receiver.size > 0) {
      receiver.bufferedChunks.unshift(receiver.buffer);
    }

    receiver.buffer = Buffer.concat(receiver.bufferedChunks);
    receiver.size = receiver.buffer.length;
    receiver.bufferedChunks = [];
    receiver.bufferedBytes = 0;
  }

  MsrpSdk.ChunkReceiver = ChunkReceiver;
};
