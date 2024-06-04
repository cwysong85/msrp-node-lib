module.exports = function(MsrpSdk) {
  // Private variables
  const chunkReceivers = {};
  let receiverCheckInterval = null;
  const chunkSenders = {};
  const activeSenders = [];

  /**
   * Socket handler
   * @param  {Object} socket Socket
   */
  const SocketHandler = function(socket) {
    // Set socket encoding so we get Strings in the 'data' event
    socket.setEncoding('utf8');

    // set a read buffer so we can cache data if we read incomplete packets
    socket.read_buffer = '';

    // Set socket timeout as needed
    if (MsrpSdk.Config.socketTimeout > 0) {
      MsrpSdk.Logger.debug(`[MSRP SocketHandler] Setting socket timeout to ${MsrpSdk.Config.socketTimeout}`);
      socket.setTimeout(MsrpSdk.Config.socketTimeout);
    }

    // Socket events:

    // On data:
    socket.on('data', function(data) {
      // Send data to tracing function
      traceMsrp(data);

      socket.read_buffer += data;

      const reg = /MSRP (\S+).*?\n-------\1[$#+]\r?\n/gs;
      let lastIndex = 0;
      while (message = reg.exec(socket.read_buffer)?.[0]) {
        // Parse each message
        const parsedMessage = MsrpSdk.parseMessage(message);
        if (!parsedMessage) {
          MsrpSdk.Logger.warn(`[MSRP SocketHandler] Unable to parse incoming message. Message was discarded. Message: ${message}`);
          continue;
        }
        // Handle each message
        if (parsedMessage.method) {
          handleIncomingRequest(message, parsedMessage, socket);
        } else {
          handleIncomingResponse(message, parsedMessage);
        }
        lastIndex = reg.lastIndex;
      }
      socket.read_buffer = socket.read_buffer.substring(lastIndex);
    });

    // On connect:
    socket.on('connect', function() {
      MsrpSdk.Logger.debug('[MSRP SocketHandler] Socket connect');
    });

    // On timeout:
    socket.on('timeout', function() {
      MsrpSdk.Logger.warn('[MSRP SocketHandler] Socket timeout');
    });

    // On error:
    socket.on('error', function(error) {
      MsrpSdk.Logger.error(`[MSRP SocketHandler] Socket error: ${error.toString()}`);
    });

    // On close:
    socket.on('close', function(hadError) {
      MsrpSdk.Logger.debug('[MSRP SocketHandler] Socket close');
    });

    /**
     * Helper function for sending messages via a specific socket
     * @param  {Object}   session    Session
     * @param  {Object}   message    Message
     * @param  {Object}   routePaths Route paths
     * @param  {Function} cb         Callback function
     */
    socket.sendMessage = function(session, message, routePaths, cb, requestReports) {
      // Sanity checks
      if (!session || !message || !routePaths) {
        MsrpSdk.Logger.error('[MSRP SocketHandler] Unable to send message. Missing arguments.');
        return;
      }

      const sender = new MsrpSdk.ChunkSender(routePaths, message.body, message.contentType, null, null, requestReports);

      // Logic for keeping track of sent heartbeats
      if (session && message.contentType === 'text/x-msrp-heartbeat') {
        session.heartbeatsTransIds[sender.nextTid] = Date.now();
        MsrpSdk.Logger.debug(`[MSRP SocketHandler] MSRP heartbeat sent to ${sender.session.toPath} (tid: ${sender.nextTid})`);
      }

      activeSenders.push({
        sender: sender,
        socket: socket,
        cb: cb
      });
      chunkSenders[sender.messageId] = sender;
      sendRequests();
    };

    return socket;
  };

  /**
   * Helper function for handling incoming requests
   * @param  {Object} request Request
   * @param  {Object} socket  Socket
   */
  function handleIncomingRequest(encodedRequest, request, socket) {
    // Retrieve Session and other needed parameters
    const toUri = new MsrpSdk.URI(request.toPath[0]);
    const fromUri = new MsrpSdk.URI(request.fromPath[0]);
    if (!toUri || !fromUri) {
      // If To-Path or From-Path is malformed return 400 BAD REQUEST
      MsrpSdk.Logger.warn('[MSRP SocketHandler] Error while handling incoming request: 400 BAD REQUEST');
      sendResponse(request, socket, request.toPath[0], MsrpSdk.Status.BAD_REQUEST);
      return;
    }
    const session = MsrpSdk.SessionController.getSession(toUri.sessionId);

    // Check if the session exists
    if (!session) {
      // If session doesn't exists, return 481 SESSION DOES NOT EXIST
      MsrpSdk.Logger.warn('[MSRP SocketHandler] Error while handling incoming request: 481 SESSION DOES NOT EXISTS');
      sendResponse(request, socket, toUri.uri, MsrpSdk.Status.SESSION_DOES_NOT_EXIST);
      return;
    }

    // If the session socket is not yet set
    if (!session.socket || session.socket.destroyed) {
      // Set the socket immediately (even if its remote address doesn't match the SDP data), and continue processing the message
      if (MsrpSdk.Config.useInboundMessageForSocketSetup === true) {
        try {
          session.setSocket(socket, false);
          // Remove the socket from the danglingSockets list if it was there
          const socketIndex = MsrpSdk.Server.danglingSockets.indexOf(socket);
          if (socketIndex !== -1) {
            MsrpSdk.Server.danglingSockets.splice(socketIndex, 1);
          }
        } catch (error) {
          MsrpSdk.Logger.error(`[MSRP SocketHandler] Error setting socket for session ${session.sid}: ${error}`);
        }
      } else {
        // Wait for the session socket to be set after the SDP handshake before processing the message
        MsrpSdk.Logger.debug(`[MSRP SocketHandler] Buffering incoming request with tid ${request.tid} for session ${toUri.sessionId} until session socket is set...`);
        session.once('socketSet', function() {
          MsrpSdk.Logger.debug(`[MSRP SocketHandler] Processing buffered incoming request with TID ${request.tid} for MSRP Session ID ${toUri.sessionId}...`);
          handleIncomingRequest(encodedRequest, request, socket);
        });
        return;
      }
    }

    // Check if remote endpoint shouldn't be sending messages because of the recvonly attribute
    if (session.remoteSdp.attributes.recvonly) {
      MsrpSdk.Logger.warn('[MSRP SocketHandler] MSRP data is not allowed when session requested "a=recvonly" in SDP. Not forwarding this message to the endpoint until "a=sendonly" or "a=sendrecv" is requested.');
      // If remote endpoint is "recvonly", return 403 FORBIDDEN
      sendResponse(request, socket, toUri.uri, MsrpSdk.Status.FORBIDDEN);
      return;
    }

    // Handle MSRP REPORT requests
    if (request.method === 'REPORT') {
      incomingReport(encodedRequest, request);
      return;
    }

    // Handle MSRP SEND requests
    if (request.method === 'SEND') {

      // Non-chunked messages
      if (request.byteRange.start === 1 && request.continuationFlag === MsrpSdk.Message.Flag.end) {
        // Emit 'message' event.
        session.emit('message', request, session, encodedRequest);
        // Return successful response: 200 OK
        sendResponse(request, socket, toUri.uri, MsrpSdk.Status.OK);
        return;
      }

      // Chunked messages
      const messageId = request.messageId;
      if (!messageId) {
        // Without message ID we are unable to piece the chunked message back together, return 400 BAD REQUEST
        sendResponse(request, socket, toUri.uri, MsrpSdk.Status.BAD_REQUEST);
        return;
      }

      // First chunk
      if (request.byteRange.start === 1) {
        // Instanciate Chunk Receiver and start Chunk Receiver poll if needed
        chunkReceivers[messageId] = new MsrpSdk.ChunkReceiver(request, 1024 * 1024);
        startChunkReceiverPoll();
        // Return successful response: 200 OK
        sendResponse(request, socket, toUri.uri, MsrpSdk.Status.OK);
        return;
      }

      // Subsequent chunks
      // We assume we receive chunk one first, so Chunk Receiver must already exist
      // TODO: Add support for chunk one arriving out of order. Ticket: https://github.com/cwysong85/msrp-node-lib/issues/15
      if (!chunkReceivers[messageId]) {
        sendResponse(request, socket, toUri.uri, MsrpSdk.Status.STOP_SENDING);
        return;
      }

      // Process received chunk and check if any error ocurrs
      if (!chunkReceivers[messageId].processChunk(request)) {
        if (chunkReceivers[messageId].remoteAbort) {
          MsrpSdk.Logger.warn('[MSRP SocketHandler] Message transmission aborted by remote endpoint');
        } else {
          MsrpSdk.Logger.error('[MSRP SocketHandler] An error occurred while processing message chunk. Message transmission aborted.');
        }
        // Clean up
        delete chunkReceivers[messageId];
        // If something fails while processing the chunk, return 413 STOP SENDING MESSAGE
        sendResponse(request, socket, toUri.uri, MsrpSdk.Status.STOP_SENDING);
        return;
      }

      // If this is not the last chunk, wait for additional chunks
      if (!chunkReceivers[messageId].isComplete()) {
        MsrpSdk.Logger.debug(`[MSRP SocketHandler] Receiving additional chunks for messageId: ${messageId}. Received bytes: ${chunkReceivers[messageId].receivedBytes}`);
        // Return successful response: 200 OK
        sendResponse(request, socket, toUri.uri, MsrpSdk.Status.OK);
        return;
      }

      // If it is the last chunk, parse the message body and clean up the receiver
      const buffer = chunkReceivers[messageId].buffer;
      delete chunkReceivers[messageId];
      request.body = buffer.toString('utf-8');
      // Emit 'message' event including the complete message
      session.emit('message', request, session, encodedRequest);
      // Return successful response: 200 OK
      sendResponse(request, socket, toUri.uri, MsrpSdk.Status.OK);
      return;
    }

    // If the request method is not understood, return 501 NOT IMPLEMENTED
    sendResponse(request, socket, toUri.uri, MsrpSdk.Status.NOT_IMPLEMENTED);
    return;
  }

  /**
   * Helper function for handling incoming responses
   * Only responses to heartbeats are being handled. The rest responses are ignored.
   * @param  {Object} response Response
   */
  function handleIncomingResponse(encodedResponse, response) {
    // Retrieve Session
    const toUri = new MsrpSdk.URI(response.toPath[0]);
    const session = MsrpSdk.SessionController.getSession(toUri.sessionId);

    // Check if the session exists
    if (!session) {
      // If session doesn't exists, log and return
      MsrpSdk.Logger.warn('[MSRP SocketHandler] Error while handling response: session does not exist');
      return;
    }
    // Check if it is a heartbeat response and handle it as needed and return
    const isHeartbeatResponse = response.tid && session && session.heartbeatsTransIds[response.tid];
    if (isHeartbeatResponse) {
      if (response.status === 200) {
        // If the response is 200OK, clear all the stored heartbeats
        MsrpSdk.Logger.debug(`[MSRP SocketHandler] MSRP heartbeat response received from ${response.fromPath} (tid: ${response.tid})`);
        session.heartbeatsTransIds = {};
      } else if (response.status >= 400) {
        // If not okay, emit 'heartbeatFailure'
        MsrpSdk.Logger.debug(`[MSRP SocketHandler] MSRP heartbeat error received from ${response.fromPath} (tid: ${response.tid})`);
        session.emit('heartbeatFailure', session);
      }
    }

    // Forward the rest of responses to the application
    // Emit event used for tracking the response of an specific request with a given TID
    session.emit(`${response.tid}Response`, response);
    // Emit general response event
    session.emit('response', response, session, encodedResponse);
  }

  /**
   * Helper function for handling incoming reports
   * @param  {Object} report Report
   */
  function incomingReport(encodedReport, report) {
    // Retrieve message ID
    const messageId = report.messageId;
    if (!messageId) {
      MsrpSdk.Logger.error('[MSRP SocketHandler] Invalid REPORT: No message ID');
      return;
    }

    // Check whether this is for a chunk sender first
    const sender = chunkSenders[messageId];
    if (!sender) {
      MsrpSdk.Logger.error('[MSRP SocketHandler] Invalid REPORT: Unknown message ID');
      // Silently ignore, as suggested in 4975 section 7.1.2
      return;
    }

    // Let the chunk sender handle the report
    sender.processReport(report);
    if (!sender.isComplete()) {
      // Still expecting more reports, no notification yet
      return;
    }

    // All chunks have been acknowledged. Clean up.
    delete chunkSenders[messageId];

    // Don't notify for locally aborted messages
    if (sender.aborted && !sender.remoteAbort) {
      return;
    }

    // Emit report event to the session if it exists
    const parsedToUri = new MsrpSdk.URI(report.toPath[0]);
    const session = MsrpSdk.SessionController.getSession(parsedToUri.sessionId);
    if (session) {
      session.emit('report', report, session, encodedReport);
    }
  }

  /**
   * Helper function for sending reports
   * @param  {Object} socket  Socket to be used for sending the report
   * @param  {Object} session Session
   * @param  {Object} req     Request asking for the report
   * @param  {Number} status  Status to be included in the report
   */
  function sendReport(socket, session, req, status) {
    const statusHeader = ['000', status, MsrpSdk.StatusComment[status]].join(' ');
    const report = new MsrpSdk.Message.OutgoingRequest({
      toPath: session.remoteEndpoints,
      localUri: session.localEndpoint.uri
    }, 'REPORT');
    report.addHeader('message-id', req.messageId);
    report.addHeader('status', statusHeader);

    if (req.byteRange || req.continuationFlag === MsrpSdk.Message.Flag.continued) {
      // A REPORT Byte-Range will be required
      let start = 1;
      let end = -1;
      let total = -1;

      if (req.byteRange) {
        // Don't trust the range end
        start = req.byteRange.start;
        total = req.byteRange.total;
      }

      if (!req.body) {
        end = 0;
      } else {
        if (req.byteRange.end === req.byteRange.total) {
          end = req.byteRange.end;
        } else {
          end = start + req.body.length - 1;
        }
      }

      if (end !== req.byteRange.end) {
        MsrpSdk.Logger.error('[MSRP SocketHandler] Report Byte-Range end does not match request');
      }

      report.byteRange = {
        'start': start,
        'end': end,
        'total': total
      };
    }

    const encodedReport = report.encode();
    socket.write(encodedReport);

    // Emit reportSent event
    session.emit('reportSent', report, session, encodedReport);

    traceMsrp(encodedReport);
  }

  /**
   * Helper function for sending request
   */
  function sendRequests() {
    while (activeSenders.length > 0) {
      // Use first sender in list
      const sender = activeSenders[0].sender;
      const socket = activeSenders[0].socket;
      const cb = activeSenders[0].cb;

      // Abort sending?
      if (sender.aborted && sender.remoteAbort) {
        // Don't send any more chunks; remove sender from list
        activeSenders.shift();
      }

      // Retrieve next chunk
      const msg = sender.getNextChunk();

      // Check socket availability before writing
      if (!socket || socket.destroyed) {
        MsrpSdk.Logger.error('[MSRP SocketHandler] Cannot send message. Socket unavailable.');
        if (cb) {
          cb(null, new Error('Socket unavailable'));
        }
        activeSenders.shift();
        continue;
      }

      // Encode and send message
      const encodeMsg = msg.encode();
      socket.write(encodeMsg);
      traceMsrp(encodeMsg);

      // Emit messageSent event to the session if it exists
      const parsedFromUri = new MsrpSdk.URI(msg.fromPath[0]);
      const session = MsrpSdk.SessionController.getSession(parsedFromUri.sessionId);
      if (session) {
        session.emit('messageSent', msg, session, encodeMsg);
      }

      // Check whether this sender has now completed
      if (sender.isSendComplete()) {
        // Remove this sender from the active list
        activeSenders.shift();
        if (cb) {
          cb(msg);
        }
      } else if (activeSenders.length > 1) {
        // For fairness, move this sender to the end of the queue
        activeSenders.push(activeSenders.shift());
      }
    }
  }

  /**
   * Helper function for sending responses
   * @param  {Object} req    Request generating the response
   * @param  {Object} socket Socket to be used for sending the response
   * @param  {String} toUri  Destination URI
   * @param  {Number} status Response status
   */
  function sendResponse(req, socket, toUri, status) {
    // Check socket availability
    if (socket.destroyed) {
      MsrpSdk.Logger.error('[MSRP SocketHandler] Unable to send message. Socket is destroyed.');
      return;
    }

    // Write message to socket
    const msg = new MsrpSdk.Message.OutgoingResponse(req, toUri, status);
    const encodeMsg = msg.encode();
    socket.write(encodeMsg, function() {
      // Emit response event to the session if it exists
      const parsedToUri = new MsrpSdk.URI(toUri);
      const session = MsrpSdk.SessionController.getSession(parsedToUri.sessionId);
      if (session) {
        session.emit('responseSent', msg, session, encodeMsg);
      }

      // After sending the message, if request has header 'success-report', send back a report
      if (req.getHeader('failure-report') === 'yes') {
        sendReport(socket, session, req, status);
      }
    });

    // Trace MSRP message
    traceMsrp(encodeMsg);
  }

  /**
   * Helper function for starting the chunk receiver poll if it's not already running.
   * This function also takes care of stopping the chunk receiver poll when it is done receiving.
   */
  function startChunkReceiverPoll() {
    if (!receiverCheckInterval) {
      receiverCheckInterval = setInterval(function() {
        const now = new Date().getTime();
        const timeout = 30 * 1000; // 30 seconds
        for (const messageId in chunkReceivers) {
          if (chunkReceivers.hasOwnProperty(messageId)) {
            const receiver = chunkReceivers[messageId];
            if (now - receiver.lastReceive > timeout) {
              // Clean up the receiver
              receiver.abort();
              delete chunkReceivers[messageId];
            }
          }
        }
        // Stop the receiver poll when done receiving
        if (MsrpSdk.Util.isEmpty(chunkReceivers)) {
          clearInterval(receiverCheckInterval);
          receiverCheckInterval = null;
        }
      });
    }
  }

  /**
   * Helper function for tracing MSRP messages
   * @param  {String} message MSRP message to be traced
   */
  function traceMsrp(message) {
    // Check if MSRP traces are disabled
    if (MsrpSdk.Config.traceMsrp === false) {
      return;
    }
    MsrpSdk.Logger.debug(`[MSRP SocketHandler] MSRP trace:\n${message}`);
  }


  MsrpSdk.SocketHandler = SocketHandler;
};
