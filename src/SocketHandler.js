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
    var session; // Stores the session for the current socket

    socket._msrpDataBuffer = new Buffer(0);

    socket.on('data', function(data) {
      // Send to tracing function
      traceMsrp(data);

      // TODO: (LVM) Review this: "socket._msrpDataBuffer = new Buffer(0);" is always called below.
      if (socket._msrpDataBuffer.length !== 0) {
        socket._msrpDataBuffer = Buffer.concat([socket._msrpDataBuffer, new Buffer(data)]);
      } else {
        socket._msrpDataBuffer = new Buffer(data);
      }

      // Parse MSRP message
      var msg = MsrpSdk.parseMessage(socket._msrpDataBuffer.toString());
      if (!msg) {
        return;
      }

      // Are the toPath and fromPath the same? We need to drop this data if so.
      if (msg.toPath[0] === msg.fromPath[0]) {
        return;
      }

      socket._msrpDataBuffer = new Buffer(0);

      // Is this a report?
      if (msg.method === 'REPORT') {
        incomingReport(msg);
        return;
      }

      // The toUri contains our Session-Id
      var toUri = new MsrpSdk.URI(msg.toPath[0]);
      var fromUri = new MsrpSdk.URI(msg.fromPath[0]);
      if (!toUri) {
        // Send bad request
        sendResponse(msg, socket, msg.toPath[0], MsrpSdk.Status.BAD_REQUEST);
        return;
      }
      session = MsrpSdk.SessionController.getSession(toUri.sessionId);

      // Check if the session exists and return forbidden if it doesn't
      if (!session) {
        // If the message we received had a status of 481 plus we don't have a session, do not send this packet because of DOS potential
        if (msg.status != 481) {
          sendResponse(msg, socket, toUri.uri, MsrpSdk.Status.SESSION_DOES_NOT_EXIST);
        }
        return;
      }

      if (session.remoteSdp.media && session.remoteSdp.media[0] && session.remoteSdp.media[0].attributes) {
        if (session.remoteSdp.media[0].attributes.recvonly) {
          MsrpSdk.Logger.warn('[MSRP SocketHandler] MSRP data is not allowed when session requested "a=recvonly" in SDP. Not forwarding this message to the endpoint until "a=sendonly" or "a=sendrecv" is requested.');
          sendResponse(msg, socket, toUri.uri, MsrpSdk.Status.FORBIDDEN);
          return;
        }
      }

      // If this is a response to a heartbeat
      if (msg.tid && session.heartbeatsTransIds[msg.tid]) {
        MsrpSdk.Logger.debug('[MSRP SocketHandler] MSRP heartbeat response received from %s (tid: %s)', msg.fromPath, msg.tid);
        // TODO: (LVM) If multiple sessions use a single socket the SocketHandler is instanciated just once and the local session variable gets overwritten.
        // We need to fix this before fixing heartbeats.
        // TODO: (LVM) Workaround by Brice for the TCC issue below. Review once the TCC is fixed.
        // Is the response good?
        if (msg.status === 200) {
          // TODO: (LVM) Luis' code
          delete session.heartbeatsTransIds[msg.tid];
          // TODO: (LVM) Brice's code
          // setTimeout(function() {
          //   session.heartbeatsTransIds = {};
          // }, 500); // (BA) timeout is a workaround, until TCC is fixed
        } else if (msg.status >= 400) { // If not okay, close session
          MsrpSdk.Logger.debug('[MSRP SocketHandler] MSRP heartbeat error received from %s (tid: %s)', msg.fromPath, msg.tid);
          // Should we close session, or account for other response codes?
          session.end();
          return;
        }
      }

      // If response, don't worry about it
      if (msg.status === 200) {
        return;
      }

      // Retrieve session local endpoint if needed
      if (!session.localEndpoint) {
        session.localEndpoint = toUri;
      }

      // TODO: (LVM) Should we send this here or only when receiving the bodiless message?
      // TODO: (LVM) Are we emitting 'socketConnect' during re-INVITEs?
      // TODO: (LVM) Is the sentSocketConnect flag blocking 'socketConnect's?
      // Retrieve session socket if needed
      if (!session.socket) {
        session.socket = socket;
        session.emit('socketConnect', session);
        session.sentSocketConnect = true;

        // Is this fromURI in our session already? If not add it
        if (!session.remoteEndpoints.includes(fromUri.uri)) {
          session.remoteEndpoints.push(fromUri.uri);
        }
      }

      // Check that the socket address matches the session socket address
      // If they don't match, a re-INVITE has updated the remote endpoint
      // Close the old socket and store the new socket in the session
      var socketRemoteAddress = socket.remoteAddress + ':' + socket.remotePort;
      var sessionSocketRemoteAddress = session.socket.remoteAddress + ':' + session.socket.remotePort;
      if (socketRemoteAddress !== sessionSocketRemoteAddress) {
        removeSocketListeners(session.socket);
        session.closeSocket();
        session.socket = socket;
      }

      // Check for bodiless SEND
      if (msg.method === 'SEND' && !msg.body && !msg.contentType) {
        sendResponse(msg, socket, toUri.uri, MsrpSdk.Status.OK);

        if (!session.sentSocketConnect) {
          session.emit('socketConnect', session);
          session.sentSocketConnect = true;
        }
        return;
      }

      var isHeartBeatMessage = (msg.contentType === 'text/x-msrp-heartbeat');
      var okStatus = true;
      try {
        if (msg.byteRange.start === 1 && msg.continuationFlag === MsrpSdk.Message.Flag.end) {
          // Non chunked message
          if (!isHeartBeatMessage) {
            session.emit('message', msg, session);
          }
        } else {
          // Chunk of a multiple-chunk message
          var msgId = msg.messageId;
          // TODO: (LVM) I think description and filename are not used later on
          var description;
          var filename;

          if (!msgId || !(msgId instanceof String || typeof msgId === 'string')) {
            sendResponse(msg, socket, toUri.uri, MsrpSdk.Status.BAD_REQUEST);
            return;
          }

          if (msg.byteRange.start === 1 && msg.continuationFlag === MsrpSdk.Message.Flag.continued) {
            // First chunk
            chunkReceivers[msgId] = new MsrpSdk.ChunkReceiver(msg, 1024 * 1024);
            description = msg.getHeader('content-description') || null;
            filename = msg.contentDisposition.param.filename || null;

            // Kick off the chunk receiver poll if it's not already running
            if (!receiverCheckInterval) {
              receiverCheckInterval = setInterval(
                function() {
                  var msgId, receiver,
                    now = new Date().getTime(),
                    timeout = 30 * 1000;
                  for (msgId in chunkReceivers) {
                    receiver = chunkReceivers[msgId];
                    if (now - receiver.lastReceive > timeout) {
                      // Clean up the receiver
                      receiver.abort();
                      delete chunkReceivers[msgId];
                    }
                  }

                  if (MsrpSdk.Util.isEmpty(chunkReceivers)) {
                    clearInterval(receiverCheckInterval);
                    receiverCheckInterval = null;
                  }
                });
            }
          } else {
            // Subsequent chunk
            if (!chunkReceivers[msgId]) {
              // We assume we will receive chunk one first
              // We could allow out-of-order, but probably not worthwhile
              sendResponse(msg, socket, toUri.uri, MsrpSdk.Status.STOP_SENDING);
              return;
            }

            if (!chunkReceivers[msgId].processChunk(msg)) {
              if (chunkReceivers[msgId].remoteAbort) {
                // TODO: what's the appropriate response to an abort?
                sendResponse(msg, socket, toUri.uri, MsrpSdk.Status.STOP_SENDING);
              } else {
                // Notify the far end of the abort
                sendResponse(msg, socket, toUri.uri, MsrpSdk.Status.STOP_SENDING);
              }
              // Message receive has been aborted
              delete chunkReceivers[msgId];
              return;
            }

            if (chunkReceivers[msgId].isComplete()) {
              var buffer = chunkReceivers[msgId].buffer;
              delete chunkReceivers[msgId];

              msg.body = buffer.toString('utf-8');

              if (!isHeartBeatMessage) {
                session.emit('message', msg, session);
              }
            } else {
              // Receive ongoing
              MsrpSdk.Logger.debug('[MSRP SocketHandler] Receiving additional chunks for MsgId: ' + msgId + ', bytesReceived: ' + chunkReceivers[msgId].receivedBytes);
            }
          }
        }
      } catch (e) {
        // Send an error response, but check which status to return
        var status = MsrpSdk.Status.INTERNAL_SERVER_ERROR;
        if (e instanceof MsrpSdk.Exceptions.UnsupportedMedia) {
          status = MsrpSdk.Status.UNSUPPORTED_MEDIA;
        } else {
          MsrpSdk.Logger.warn('[MSRP SocketHandler] Unexpected application exception: ' + e.stack);
        }
        sendResponse(msg, socket, toUri.uri, status);
        return;
      }

      if (okStatus) {
        sendResponse(msg, socket, toUri.uri, MsrpSdk.Status.OK);
        return;
      }


    });

    // TODO: (LVM) This listener should emit the 'socketConnect' event.
    // The other 'socketConnect' event emitted by the SocketHandler is actually
    // something like a 'bodylessMessageReceived' event.
    // Since we are supporting inbound connections it is not the same anymore.
    socket.on('connect', function() {
      MsrpSdk.Logger.debug('[MSRP SocketHandler] Socket connect');
    });

    socket.on('timeout', function() {
      MsrpSdk.Logger.warn('[MSRP SocketHandler] Socket timeout');
      if (session) {
        session.emit('socketTimeout', session);
      }
    });

    socket.on('error', function(error) {
      MsrpSdk.Logger.error('[MSRP SocketHandler] Socket error:', error);
      if (session) {
        session.emit('socketError', error, session);
      }
    });

    socket.on('close', function(hadError) {
      MsrpSdk.Logger.debug('[MSRP SocketHandler] Socket close');
      if (session) {
        session.emit('socketClose', hadError, session);
      }
    });

    socket.on('send', function(message, routePaths, cb) {
      if (!message || !routePaths) {
        return;
      }

      var sender = new MsrpSdk.ChunkSender(routePaths, message.body, message.contentType);

      // Logic for keeping track of sent heartbeats
      if (session && message.contentType === 'text/x-msrp-heartbeat') {
        session.heartbeatsTransIds[sender.tid] = Date.now();
        MsrpSdk.Logger.debug('[MSRP SocketHandler] MSRP heartbeat sent to %s (tid: %s)', sender.session.toPath, sender.tid);
      }

      activeSenders.push({
        sender: sender,
        socket: socket,
        cb: cb
      });
      chunkSenders[sender.messageId] = sender;
      sendRequests();
    });

    return socket;
  };

  /**
   * Helper function for tracing MSRP messages
   * @param  {Object} data Data. Supported types: String and Buffer.
   */
  function traceMsrp(data) {
    if (!data || !MsrpSdk.Config.traceMsrp) return;
    var print = '';
    if (data instanceof String || typeof data === 'string') {
      print += data;
    } else if (data instanceof Buffer) {
      print += String.fromCharCode.apply(null, new Uint8Array(data));
    } else {
      MsrpSdk.Logger.warn('[MSRP SocketHandler] Cannot trace MSRP. Unsupported data type');
      return;
    }
    MsrpSdk.Logger.info('[MSRP SocketHandler] ' + print);
  }

  /**
   * Helper function for sending responses
   * @param  {Object} req    Request generating the response
   * @param  {Object} socket Socket to be used for sending the response
   * @param  {String} toUri  Destination URI
   * @param  {Number} status Response status
   */
  function sendResponse(req, socket, toUri, status) {
    var msg = new MsrpSdk.Message.OutgoingResponse(req, toUri, status);
    var encodeMsg = msg.encode();

    // Write message to socket
    socket.write(encodeMsg, function() {
      // After sending the message, if request has header 'success-report', send back a report
      if (req.getHeader('success-report') === 'yes' && status === MsrpSdk.Status.OK) {
        sendReport(socket, {
          toPath: req.fromPath,
          localUri: toUri
        }, req);
      }
      if (req.getHeader('failure-report') === 'yes' && status !== MsrpSdk.Status.OK) {
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
   * Helper function for handling incoming reports
   * @param  {Object} report Report
   */
  function incomingReport(report) {
    // Retrieve message ID
    var msgId = report.messageId;
    if (!msgId) {
      MsrpSdk.Logger.error('[MSRP SocketHandler] Invalid REPORT: no message id');
      return;
    }

    // Check whether this is for a chunk sender first
    var sender = chunkSenders[msgId];
    if (!sender) {
      MsrpSdk.Logger.error('[MSRP SocketHandler] Invalid REPORT: unknown message id');
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
    delete chunkSenders[msgId];

    // Don't notify for locally aborted messages
    if (sender.aborted && !sender.remoteAbort) {
      return;
    }
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

      var msg = sender.getNextChunk();
      var encodeMsg = msg.encode();
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
   * Helper function for sending reports
   * @param  {Object} socket  Socket to be used for sending the report
   * @param  {Object} session Session
   * @param  {Object} req     Request asking for the report
   * @param  {Number} status  Status to be included in the report
   */
  function sendReport(socket, session, req, status) {
    var report;
    var statusNS = '000';

    if (!status) {
      status = MsrpSdk.Status.OK + ' ' + MsrpSdk.StatusComment['200'];
    } else {
      status = status + ' ' + MsrpSdk.StatusComment[status];
    }

    report = new MsrpSdk.Message.OutgoingRequest(session, 'REPORT');
    report.addHeader('message-id', req.messageId);
    report.addHeader('status', statusNS + ' ' + status);

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
   * Helper function for removing all listeners attached to a socket
   * @param  {Object} socket Socket
   */
  function removeSocketListeners(socket) {
    socket.removeAllListeners('data');
    socket.removeAllListeners('connect');
    socket.removeAllListeners('timeout');
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
    socket.removeAllListeners('send');
  }

  MsrpSdk.SocketHandler = SocketHandler;
};
