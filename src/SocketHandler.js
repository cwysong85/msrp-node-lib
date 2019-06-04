module.exports = function(MsrpSdk) {
  // Private variables
  var chunkReceivers = {};
  var receiverCheckInterval = null;
  var chunkSenders = {};
  var activeSenders = [];

  /**
   * Socket handler
   * @param  {Object} socket Socket
   */
  var SocketHandler = function(socket) {
    // Set socket encoding so we get Strings in the 'data' event
    socket.setEncoding('utf8');

    // Set socket timeout as needed
    if (MsrpSdk.Config.socketTimeout > 0) {
      MsrpSdk.Logger.debug('[MSRP SocketHandler] Setting socket timeout to', MsrpSdk.Config.socketTimeout);
      socket.setTimeout(MsrpSdk.Config.socketTimeout);
    }

    // Socket events:

    // On data:
    socket.on('data', function(data) {
      // Send data to tracing function
      traceMsrp(data);

      // Incoming data may include more than one MSRP message. Match messages using regex.
      var messages = data.match(/MSRP .*?-{7}\S*?[$#+]/gs);
      messages.forEach(function(message) {
        // Parse each message
        var parsedMessage = MsrpSdk.parseMessage(message);
        if (!parsedMessage) {
          MsrpSdk.Logger.warn('[MSRP SocketHandler] Unable to parse incoming message. Message was discarded. Message:', message);
          return;
        }
        // Handle each message
        if (parsedMessage.method) {
          handleIncomingRequest(parsedMessage, socket);
        } else {
          handleIncomingResponse(parsedMessage);
        }
      });
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
      MsrpSdk.Logger.error('[MSRP SocketHandler] Socket error:', error);
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
    socket.sendMessage = function(session, message, routePaths, cb) {
      // Sanity checks
      if (!session || !message || !routePaths) {
        MsrpSdk.Logger.error('[MSRP SocketHandler] Unable to send message. Missing arguments.');
        return;
      }

      var sender = new MsrpSdk.ChunkSender(routePaths, message.body, message.contentType);

      // Logic for keeping track of sent heartbeats
      if (session && message.contentType === 'text/x-msrp-heartbeat') {
        session.heartbeatsTransIds[sender.nextTid] = Date.now();
        MsrpSdk.Logger.debug('[MSRP SocketHandler] MSRP heartbeat sent to %s (tid: %s)', sender.session.toPath, sender.nextTid);
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
  function handleIncomingRequest(request, socket) {
    // Retrieve Session and other needed parameters
    var toUri = new MsrpSdk.URI(request.toPath[0]);
    var fromUri = new MsrpSdk.URI(request.fromPath[0]);
    if (!toUri || !fromUri) {
      // If To-Path or From-Path is malformed return 400 BAD REQUEST
      MsrpSdk.Logger.warn('[MSRP SocketHandler] Error while handling incoming request: 400 BAD REQUEST');
      sendResponse(request, socket, request.toPath[0], MsrpSdk.Status.BAD_REQUEST);
      return;
    }
    var session = MsrpSdk.SessionController.getSession(toUri.sessionId);

    // Check if the session exists
    if (!session) {
      // If session doesn't exists, return 481 SESSION DOES NOT EXIST
      MsrpSdk.Logger.warn('[MSRP SocketHandler] Error while handling incoming request: 481 SESSION DOES NOT EXISTS');
      sendResponse(request, socket, toUri.uri, MsrpSdk.Status.SESSION_DOES_NOT_EXIST);
      return;
    }

    // Set session socket if needed
    if (!session.socket) {
      session.setSocket(socket);
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
      incomingReport(request);
      return;
    }

    // Handle MSRP SEND requests
    if (request.method === 'SEND') {

      // Non-chunked messages
      if (request.byteRange.start === 1 && request.continuationFlag === MsrpSdk.Message.Flag.end) {
        // Emit 'message' event. Do not emit it for heartbeat messages or bodyless messages.
        var isHeartbeatMessage = (request.contentType === 'text/x-msrp-heartbeat');
        var isBodylessMessage = (!request.body && !request.contentType);
        if (!isHeartbeatMessage && !isBodylessMessage) {
          session.emit('message', request, session);
        }
        // Return successful response: 200 OK
        sendResponse(request, socket, toUri.uri, MsrpSdk.Status.OK);
        return;
      }

      // Chunked messages
      var messageId = request.messageId;
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
        MsrpSdk.Logger.debug('[MSRP SocketHandler] Receiving additional chunks for messageId: ' + messageId + ', bytesReceived: ' + chunkReceivers[messageId].receivedBytes);
        // Return successful response: 200 OK
        sendResponse(request, socket, toUri.uri, MsrpSdk.Status.OK);
        return;
      }

      // If it is the last chunk, parse the message body and clean up the receiver
      var buffer = chunkReceivers[messageId].buffer;
      delete chunkReceivers[messageId];
      request.body = buffer.toString('utf-8');
      // Emit 'message' event including the complete message
      session.emit('message', request, session);
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
  function handleIncomingResponse(response) {
    // Retrieve Session
    var toUri = new MsrpSdk.URI(response.toPath[0]);
    var session = MsrpSdk.SessionController.getSession(toUri.sessionId);

    // Check if it is a heartbeat response and handle it as needed
    var isHeartbeatResponse = response.tid && session && session.heartbeatsTransIds[response.tid];
    if (isHeartbeatResponse) {
      if (response.status === 200) {
        // If the response is 200OK, clear all the stored heartbeats
        MsrpSdk.Logger.debug('[MSRP SocketHandler] MSRP heartbeat response received from %s (tid: %s)', response.fromPath, response.tid);
        session.heartbeatsTransIds = {};
      } else if (response.status >= 400) {
        // If not okay, emit 'heartbeatFailure'
        MsrpSdk.Logger.debug('[MSRP SocketHandler] MSRP heartbeat error received from %s (tid: %s)', response.fromPath, response.tid);
        session.emit('heartbeatFailure', session);
      }
    }

    // TODO: Handle other incoming responses. Ticket: https://github.com/cwysong85/msrp-node-lib/issues/16
  }

  /**
   * Helper function for handling incoming reports
   * @param  {Object} report Report
   */
  function incomingReport(report) {
    // Retrieve message ID
    var messageId = report.messageId;
    if (!messageId) {
      MsrpSdk.Logger.error('[MSRP SocketHandler] Invalid REPORT: No message ID');
      return;
    }

    // Check whether this is for a chunk sender first
    var sender = chunkSenders[messageId];
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

    // TODO: Pass incoming reports to the application. Ticket: https://github.com/cwysong85/msrp-node-lib/issues/17
  }

  /**
   * Helper function for sending reports
   * @param  {Object} socket  Socket to be used for sending the report
   * @param  {Object} session Session
   * @param  {Object} req     Request asking for the report
   * @param  {Number} status  Status to be included in the report
   */
  function sendReport(socket, session, req, status) {
    var statusHeader = ['000', status, MsrpSdk.StatusComment[status]].join(' ');
    var report = new MsrpSdk.Message.OutgoingRequest(session, 'REPORT');
    report.addHeader('message-id', req.messageId);
    report.addHeader('status', statusHeader);

    if (req.byteRange || req.continuationFlag === MsrpSdk.Message.Flag.continued) {
      // A REPORT Byte-Range will be required
      var start = 1;
      var end = -1;
      var total = -1;

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

    var encodeMsg = report.encode();
    socket.write(encodeMsg);
    traceMsrp(encodeMsg);
  }

  /**
   * Helper function for sending request
   */
  function sendRequests() {
    while (activeSenders.length > 0) {
      // Use first sender in list
      var sender = activeSenders[0].sender;
      var socket = activeSenders[0].socket;
      var cb = activeSenders[0].cb;

      // Abort sending?
      if (sender.aborted && sender.remoteAbort) {
        // Don't send any more chunks; remove sender from list
        activeSenders.shift();
      }

      // Retrieve and encode next chunk
      var msg = sender.getNextChunk();
      var encodeMsg = msg.encode();
      // Check socket availability before writing
      if (socket.destroyed) {
        MsrpSdk.Logger.error('[MSRP SocketHandler] Unable to send message. Socket is destroyed.');
        return;
      }
      socket.write(encodeMsg);
      traceMsrp(encodeMsg);

      // Check whether this sender has now completed
      if (sender.isSendComplete()) {
        // Remove this sender from the active list
        activeSenders.shift();
        if (cb) {
          cb();
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
    var msg = new MsrpSdk.Message.OutgoingResponse(req, toUri, status);
    var encodeMsg = msg.encode();
    socket.write(encodeMsg, function() {
      // After sending the message, if request has header 'success-report', send back a report
      if (req.getHeader('failure-report') === 'yes') {
        sendReport(socket, {
          toPath: req.fromPath,
          localUri: toUri
        }, req, status);
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
        var now = new Date().getTime();
        var timeout = 30 * 1000; // 30 seconds
        for (var messageId in chunkReceivers) {
          var receiver = chunkReceivers[messageId];
          if (now - receiver.lastReceive > timeout) {
            // Clean up the receiver
            receiver.abort();
            delete chunkReceivers[messageId];
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
    MsrpSdk.Logger.debug('[MSRP SocketHandler]', message);
  }


  MsrpSdk.SocketHandler = SocketHandler;
};
