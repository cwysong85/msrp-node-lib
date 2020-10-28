'use strict';

// eslint-disable-next-line max-lines-per-function
module.exports = function (MsrpSdk) {

  const MSRP_REGEX = /MSRP (\S+) [\s\S]*?\r\n-{7}\1[$#+]\r\n/g;

  const AUDIT_INTERVAL = 5000; // 5 seconds
  const PENDING_SOCKET_TIMEOUT = 15000; // 15 seconds
  const RCV_TIMEOUT = 30000; // 30 seconds
  const MAX_BUFFERED_DATA = 1024 * 1024; // 1 MB

  // Private variables
  const connectedSockets = new Set(); // Set with all connected sockets
  const pendingAssociations = new Map();  // Connected sockets which are not yet associated with an MSRP session

  const chunkReceivers = new Map();
  const chunkSenders = new Map();
  const pendingReports = new Map();
  const requestsSent = new Map();

  const activeSenders = [];

  let socketsAuditInterval = null;
  let receiverCheckInterval = null;
  let senderTimeout = null;

  function getSocketInfo(socket) {
    const socketAddr = socket.address() || {};
    const local = `${socketAddr.address}:${socketAddr.port}`;
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    return `Local: ${local}, Remote: ${remote}`;
  }

  /**
   * Get a connected socket for a given remote address and port
   * @param {object} remoteServer remote connection info
   * @return {object} A connected socket, if found
   */
  const getConnectedSocket = function (remoteServer) {
    for (const s of connectedSockets.values()) {
      if (s.remoteAddressPort === remoteServer) {
        return s;
      }
    }
    return null;
  };
  MsrpSdk.getConnectedSocket = getConnectedSocket;

  /**
   * Socket handler
   * @param {object} socket Socket
   */
  const SocketHandler = function (socket) {
    let socketInfo = '';
    let bufferedData = '';

    // The sessionId for all MSRP sessions using the socket
    socket.sessions = new Set();

    // Set socket encoding so we get Strings in the 'data' event
    socket.setEncoding('utf8');

    // Set socket timeout as needed
    if (MsrpSdk.Config.socketTimeout > 0) {
      MsrpSdk.Logger.debug(`[SocketHandler]: Set socket timeout to ${MsrpSdk.Config.socketTimeout} seconds`);
      socket.setTimeout(MsrpSdk.Config.socketTimeout * 1000);
    }

    // Register for socket events

    const onSocketConnected = function () {
      socketInfo = getSocketInfo(socket);
      socket.socketInfo = socketInfo;
      socket.remoteAddressPort = `${socket.remoteAddress}:${socket.remotePort}`;
      connectedSockets.add(socket);
      pendingAssociations.set(socket, Date.now());
      startSocketsAudit();
      MsrpSdk.Logger.info(`[SocketHandler]: Socket connected. ${socketInfo}. Num active sockets: ${connectedSockets.size}`);
    };

    if (socket.writable || socket.readable) {
      // Socket is already connected
      onSocketConnected();
    } else {
      socket.on('connect', onSocketConnected);
    }

    socket.on('timeout', () => {
      MsrpSdk.Logger.warn(`[SocketHandler]: Socket timeout. ${socketInfo}`);
      socket.destroy();
    });

    socket.on('error', error => {
      MsrpSdk.Logger.error(`[SocketHandler]: Socket error. ${socketInfo || getSocketInfo(socket)}.`, error);
    });

    socket.on('data', data => {
      if (!MsrpSdk.Config.isProduction) {
        MsrpSdk.Logger.debug(`[SocketHandler]: Received >>>\r\n${data}`);
      }

      if (bufferedData) {
        // Prepend the buffered data
        data = bufferedData + data;
      }

      // Find the start of the first message
      MSRP_REGEX.lastIndex = 0;
      let msgMatch = MSRP_REGEX.exec(data);
      let lastIndex = 0;

      while (msgMatch) {
        try {
          // Move lastIndex to the end of the matched message
          lastIndex = MSRP_REGEX.lastIndex;

          const [message] = msgMatch;
          if (MsrpSdk.Config.traceMsrp) {
            MsrpSdk.Logger.info(`[SocketHandler]: MSRP received (${socketInfo}) - \r\n${MsrpSdk.Util.obfuscateMessage(message)}`);
          }
          const parsedMessage = MsrpSdk.parseMessage(message);
          if (!parsedMessage) {
            MsrpSdk.Logger.warn('[SocketHandler]: Unable to parse incoming message. Message was discarded.');
          } else if (parsedMessage.method) {
            handleIncomingRequest(parsedMessage, socket);
          } else {
            handleIncomingResponse(parsedMessage);
          }
        } catch (e) {
          MsrpSdk.Logger.error('[SocketHandler]: Exception handling message.', e);
        }
        // Look for next message
        msgMatch = MSRP_REGEX.exec(data);
      }

      // Buffer any remaining data that hasn't been processed
      bufferedData = lastIndex === 0 ? data : data.slice(lastIndex);

      if (bufferedData.length > MAX_BUFFERED_DATA) {
        MsrpSdk.Logger.warn('[SocketHandler]: Buffered data has exceeded max allowed size. Discard all buffered data.');
        bufferedData = '';
      }
    });

    socket.on('close', () => {
      connectedSockets.delete(socket);
      pendingAssociations.delete(socket);
      MsrpSdk.Logger.info(`[SocketHandler]: Socket closed. ${socketInfo}. Num active sockets: ${connectedSockets.size}`);
    });

    /**
     * Helper function for sending initial session message via a specific socket.
     *
     * @param {object} session Session
     * @param {Function} [onMessageSent] Callback function invoked when request is sent.
     */
    socket.startSession = function (session, onMessageSent) {
      if (!session) {
        throw new Error('Session is mandatory');
      }

      // Socket is associated with session. Remove from pending list (if applicable).
      pendingAssociations.delete(socket);

      // Send bodiless MSRP message
      const request = new MsrpSdk.Message.OutgoingRequest({
        toPath: session.remoteEndpoints,
        fromPath: [session.localEndpoint.uri]
      }, 'SEND');
      const encodeMsg = request.encode();

      socket.write(encodeMsg, () => {
        if (MsrpSdk.Config.traceMsrp) {
          MsrpSdk.Logger.info(`[SocketHandler]: MSRP sent (${socket.socketInfo}) - \r\n${encodeMsg}`);
        }
        if (typeof onMessageSent === 'function') {
          onMessageSent();
        }
      });
    };

    /**
     * Helper function for sending messages via a specific socket.
     *
     * @param {object} session Session
     * @param {object} message Message
     * @param {Function} [onMessageSent] Callback function invoked when request is sent.
     * @param {Function} [onReportReceived] Callback function invoked when report is received.
     */
    socket.sendMessage = function (session, message, onMessageSent, onReportReceived) {
      // Sanity checks
      if (!session || !message) {
        MsrpSdk.Logger.error('[SocketHandler]: Unable to send message. Missing arguments.');
        return;
      }

      const routePaths = {
        toPath: session.remoteEndpoints,
        fromPath: [session.localEndpoint.uri]
      };
      const sender = new MsrpSdk.ChunkSender(routePaths, message, (status, messageId) => {
        // We are done processing reports for this sender
        chunkSenders.delete(messageId);
        sender.tidList.forEach(tid => requestsSent.delete(tid));
        MsrpSdk.Logger.debug(`[SocketHandler]: Removed sender for ${messageId}. Num active senders: ${chunkSenders.size}`);

        if (typeof onReportReceived === 'function') {
          onReportReceived(status, messageId);
        }
      });

      chunkSenders.set(sender.messageId, sender);
      MsrpSdk.Logger.debug(`[SocketHandler]: Created new sender for ${sender.messageId}. Num active senders: ${chunkSenders.size}`);

      activeSenders.push({
        sender,
        socket,
        onMessageSent
      });

      sendRequests();
    };

    /**
     * Sends the pending REPORT message for the given messageId.
     *
     * @param {string} messageId The messageId.
     * @param {number} [status] The report status code.
     */
    socket.sendReport = function (messageId, status) {
      MsrpSdk.Logger.info(`[SocketHandler]: Send REPORT for message ${messageId} with status ${status}`);

      const pendingData = pendingReports.get(messageId);
      if (!pendingData) {
        MsrpSdk.Logger.warn(`[SocketHandler]: There is no pending REPORT for message ${messageId}`);
        return;
      }
      if (pendingData.socket !== socket) {
        MsrpSdk.Logger.warn('[SocketHandler]: Pending REPORT is for a different socket');
        // Go ahead and send report anyway
      }

      sendPendingReport(messageId, status);
    };

    return socket;
  };

  /**
   * Helper function for handling incoming requests
   * @param {object} request Request
   * @param {object} socket Socket
   */
  function handleIncomingRequest(request, socket) {
    // Retrieve Session and other needed parameters
    let toUri;
    try {
      toUri = new MsrpSdk.URI(request.toPath[0]);
    } catch (err) {
      MsrpSdk.Logger.warn('[SocketHandler]: Error while parsing to/from URIs: 400 BAD REQUEST');
      sendResponse(request, socket, request.toPath[0], MsrpSdk.Status.BAD_REQUEST);
      return;
    }
    const session = MsrpSdk.SessionController.getSession(toUri.sessionId);

    // Check if the session exists
    if (!session) {
      // If session doesn't exists, return 481 SESSION DOES NOT EXIST
      MsrpSdk.Logger.warn('[SocketHandler]: Error while handling incoming request: 481 SESSION DOES NOT EXISTS');
      sendResponse(request, socket, toUri.uri, MsrpSdk.Status.SESSION_DOES_NOT_EXIST);
      return;
    }
    // Socket is associated with session. Remove from pending list (if applicable).
    pendingAssociations.delete(socket);

    if (request.fromPath[0] !== session.remoteEndpoints[0]) {
      sendResponse(request, socket, toUri.uri, MsrpSdk.Status.SESSION_DOES_NOT_EXIST, 'Invalid From-Path');
      return;
    }

    // Set session socket if there is no current socket set
    if (socket !== session.socket) {
      session.setSocket(socket);
    }

    switch (request.method) {
      case 'REPORT':
        if (request.status === MsrpSdk.Status.OK) {
          session.resetHeartbeat();
        }
        incomingReport(request);
        break;
      case 'SEND':
        session.resetHeartbeat();
        incomingSend(request, socket, session, toUri);
        break;
      default:
        // If the request method is not understood, return 501 NOT IMPLEMENTED
        sendResponse(request, socket, toUri.uri, MsrpSdk.Status.NOT_IMPLEMENTED);
        break;
    }
  }

  /**
   * Helper function for handling incoming responses.
   *
   * @param {object} response - The response object.
   */
  function handleIncomingResponse(response) {
    const messageId = requestsSent.get(response.tid);
    if (messageId) {
      requestsSent.delete(response.tid);
      MsrpSdk.Logger.info(`[SocketHandler]: Received response for tid:${response.tid} and messageId:${messageId}. Num pending responses: ${requestsSent.size}`);
      const sender = chunkSenders.get(messageId);
      sender && sender.processResponse(response);
    }
  }

  /**
   * Helper function for handling incoming reports.
   *
   * @param {object} report - The request object.
   */
  function incomingReport(report) {
    // Retrieve message ID
    const { messageId } = report;
    if (!messageId) {
      MsrpSdk.Logger.error('[SocketHandler]: Invalid REPORT: No message ID');
      return;
    }

    // Check whether this is for a chunk sender first
    const sender = chunkSenders.get(messageId);
    if (!sender) {
      // Silently ignore, as suggested in 4975 section 7.1.2
      MsrpSdk.Logger.debug('[SocketHandler]: REPORT for unknown message ID');
      return;
    }

    // Let the chunk sender handle the report
    sender.processReport(report);
  }

  function incomingSend(request, socket, session, toUri) {
    // Check if remote endpoint shouldn't be sending messages because of the recvonly attribute
    const connectionMode = session.remoteConnectionMode;
    if (connectionMode === 'recvonly' || connectionMode === 'inactive') {
      MsrpSdk.Logger.warn(`[SocketHandler]: MSRP data is not allowed when session requested "a=${connectionMode}" in SDP`);
      sendResponse(request, socket, toUri.uri, MsrpSdk.Status.FORBIDDEN);
      return;
    }

    // Non-chunked messages
    if (request.isComplete()) {
      // Return successful response: 200 OK
      sendResponse(request, socket, toUri.uri, MsrpSdk.Status.OK);

      // Emit 'message' event. Do not emit it for heartbeat messages or bodiless messages.
      const isHeartbeatMessage = request.contentType === 'text/x-msrp-heartbeat';
      const isBodilessMessage = !request.body;
      if (!isHeartbeatMessage && !isBodilessMessage) {
        try {
          session.emit('message', request, session);
        } catch (err) {
          MsrpSdk.Logger.error('[SocketHandler]: Error raising "message" event.', err);
        }
      }
      return;
    }

    // Chunked messages
    const { messageId } = request;
    if (!messageId || !request.byteRange) {
      // Without message ID we are unable to piece the chunked message back together, return 400 BAD REQUEST
      sendResponse(request, socket, toUri.uri, MsrpSdk.Status.BAD_REQUEST);
      return;
    }

    // Process received chunk and check if any error occurs
    let receiver = chunkReceivers.get(messageId);
    if (!receiver) {
      // Instanciate Chunk Receiver and start Chunk Receiver poll if needed
      receiver = new MsrpSdk.ChunkReceiver(messageId);
      chunkReceivers.set(messageId, receiver);
      MsrpSdk.Logger.debug(`[SocketHandler]: Created new receiver for ${messageId}. Num active receivers: ${chunkReceivers.size}`);
      startCheckInterval();
    }

    if (!receiver.processChunk(request)) {
      if (receiver.remoteAbort) {
        MsrpSdk.Logger.warn('[SocketHandler]: Message transmission aborted by remote endpoint');
      } else {
        MsrpSdk.Logger.error('[SocketHandler]: An error occurred while processing message chunk. Message transmission aborted.');
      }
      // Clean up
      chunkReceivers.delete(messageId);
      MsrpSdk.Logger.debug(`[SocketHandler]: Removed receiver for ${messageId}. Num active receivers: ${chunkReceivers.size}`);

      // If something fails while processing the chunk, return 413 STOP SENDING MESSAGE
      sendResponse(request, socket, toUri.uri, MsrpSdk.Status.STOP_SENDING);
      return;
    }

    if (!receiver.isComplete()) {
      // Return successful response: 200 OK
      sendResponse(request, socket, toUri.uri, MsrpSdk.Status.OK);
      return;
    }

    // This is the last chunk. Parse the message body and clean up the receiver.
    chunkReceivers.delete(messageId);
    MsrpSdk.Logger.debug(`[SocketHandler]: Removed receiver for ${messageId}. Num active receivers: ${chunkReceivers.size}`);

    // Update request as if entire message was received
    request.body = receiver.buffer.toString('utf-8');
    request.continuationFlag = MsrpSdk.Message.Flag.end;
    request.byteRange = {
      start: 1,
      end: receiver.size,
      total: receiver.size
    };

    // Return successful response: 200 OK
    sendResponse(request, socket, toUri.uri, MsrpSdk.Status.OK);

    // Emit 'message' event including the complete message
    try {
      session.emit('message', request, session);
    } catch (err) {
      MsrpSdk.Logger.error('[SocketHandler]: Error raising "message" event.', err);
    }
  }

  /**
   * Helper function for sending reports
   * @param {object} socket Socket to be used for sending the report
   * @param {object} routePaths The message paths.
   * @param {Array} routePaths.toPath The To-Path uris.
   * @param {Array} routePaths.fromPath The From-Path uris.
   * @param {object} req Request asking for the report
   * @param {number} status Status to be included in the report
   */
  function sendReport(socket, routePaths, req, status) {
    try {
      const isSuccess = status === MsrpSdk.Status.OK;
      if (isSuccess) {
        // Note: As allowed in RFC4975, we only send the Success Report after receiving all message chunks.
        if (!req.isComplete() || req.getHeader('Success-Report') !== 'yes') {
          // No need to send a Success Report
          return;
        }
      } else if (req.getHeader('Failure-Report') === 'no') {
        // No need to send a Failure Report
        return;
      }

      if (!socket.writable) {
        MsrpSdk.Logger.warn(`[SocketHandler]: Unable to send report for ${req.messageId}. Socket is not writable.`);
        return;
      }

      const statusHeader = `000 ${status} ${MsrpSdk.StatusComment[status]}`;
      const report = new MsrpSdk.Message.OutgoingRequest(routePaths, 'REPORT');
      report.setHeader('Message-ID', req.messageId);
      report.setHeader('Status', statusHeader);
      if (req.byteRange) {
        if (isSuccess) {
          report.byteRange = req.byteRange;
        } else {
          // RFC4975
          // If a failure REPORT request is sent in response to a SEND request
          // that contained a chunk, it MUST include a Byte-Range header field
          // indicating the actual range being reported on.  It can take the
          // range-start and total values from the original SEND request, but MUST
          // calculate the range-end field from the actual body data
          report.byteRange = {
            start: req.byteRange.start,
            end: req.body ? req.byteRange.start + Buffer.byteLength(req.body, 'utf8') - 1 : 0,
            total: req.byteRange.total
          };
        }
      }

      if (isSuccess && MsrpSdk.Config.manualReports) {
        // Save the REPORT message to be sent when requested by the application
        pendingReports.set(req.messageId, {
          report,
          socket,
          timestamp: Date.now()
        });
        startCheckInterval();
      } else {
        // Send the REPORT message
        const encodeMsg = report.encode();
        socket.write(encodeMsg, () => {
          if (MsrpSdk.Config.traceMsrp) {
            MsrpSdk.Logger.info(`[SocketHandler]: MSRP sent (${socket.socketInfo}) - \r\n${encodeMsg}`);
          }
        });
      }
    } catch (err) {
      MsrpSdk.Logger.error('[SocketHandler]: Error sending report.', err);
    }
  }

  /**
   * Sends the pending REPORT message for the given messageId.
   *
   * @param {string} messageId The messageId.
   * @param {number} [status] The report status code.
   */
  function sendPendingReport(messageId, status = MsrpSdk.Status.OK) {
    const pendingData = pendingReports.get(messageId);
    if (!pendingData) {
      return;
    }
    // First remove the entry from the pending array
    pendingReports.delete(messageId);

    const { socket, report } = pendingData;

    // Check socket availability
    if (socket.destroyed) {
      MsrpSdk.Logger.warn('[SocketHandler]: Unable to send report. Socket is destroyed.');
      return;
    }

    if (!socket.writable) {
      MsrpSdk.Logger.warn('[SocketHandler]: Unable to send report. Socket is not writable.');
      return;
    }

    if (status !== MsrpSdk.Status.OK) {
      // Update Status header before sending the message
      const statusHeader = `000 ${status} ${MsrpSdk.StatusComment[status]}`;
      report.setHeader('Status', statusHeader);
    }

    // Send the REPORT message
    const encodeMsg = report.encode();
    socket.write(encodeMsg, () => {
      if (MsrpSdk.Config.traceMsrp) {
        MsrpSdk.Logger.info(`[SocketHandler]: MSRP sent (${socket.socketInfo}) - \r\n${encodeMsg}`);
      }
    });
  }

  /**
   * Helper function for sending request
   */
  function sendNextRequest() {
    if (!activeSenders.length) {
      return;
    }

    // Get first sender in list
    const activeSender = activeSenders.shift();
    const { sender, socket, onMessageSent } = activeSender;

    // Check socket availability before writing
    if (!socket || socket.destroyed) {
      MsrpSdk.Logger.error('[SocketHandler]: Cannot send message. Socket unavailable.');
      return;
    }

    // Retrieve and encode next chunk
    const msg = sender.getNextChunk();
    const encodeMsg = msg.encode();


    socket.write(encodeMsg, () => {
      if (msg.method === 'SEND') {
        requestsSent.set(msg.tid, sender.messageId);
      }
      if (MsrpSdk.Config.traceMsrp) {
        MsrpSdk.Logger.info(`[SocketHandler]: MSRP sent (${socket.socketInfo}) - \r\n${sender.isHeartbeat ? encodeMsg : MsrpSdk.Util.obfuscateMessage(encodeMsg)}`);
      }
    });

    // Check whether this sender has now completed
    if (sender.isSendComplete()) {
      // Remove this sender from the active list
      if (typeof onMessageSent === 'function') {
        onMessageSent(sender.messageId);
      }
    } else {
      // Add sender back to the queue
      activeSenders.push(activeSender);
    }
  }

  function sendRequests() {
    if (senderTimeout || !activeSenders.length) {
      return;
    }
    // Send the requests asynchronously
    senderTimeout = setTimeout(() => {
      senderTimeout = null;
      MsrpSdk.Logger.info(`Sending messages - Num pending requests: ${activeSenders.length}`);
      // Send up to 5 messages at a time
      for (let count = 0; count < 5 && activeSenders.length; count++) {
        try {
          sendNextRequest();
        } catch (err) {
          MsrpSdk.Logger.error('[SocketHandler]: Failed to send request.', err);
        }
      }
      sendRequests();
    }, 0);
  }

  /**
   * Helper function for sending responses
   * @param {object} req Request generating the response
   * @param {object} socket Socket to be used for sending the response
   * @param {string} toUri Destination URI
   * @param {number} status Response status
   * @param {string} [comment] Response comment
   */
  function sendResponse(req, socket, toUri, status, comment) {
    // Check socket availability
    if (socket.destroyed) {
      MsrpSdk.Logger.warn('[SocketHandler]: Unable to send response. Socket is destroyed.');
      return;
    }

    if (!socket.writable) {
      MsrpSdk.Logger.warn('[SocketHandler]: Unable to send response. Socket is not writable.');
      return;
    }

    const routePaths = {
      toPath: req.fromPath,
      fromPath: [toUri]
    };

    const isSuccess = status === MsrpSdk.Status.OK;
    if (isSuccess ? req.responseOn.success : req.responseOn.failure) {
      // Send response
      const msg = new MsrpSdk.Message.OutgoingResponse(req, toUri, status, comment);
      const encodeMsg = msg.encode();
      socket.write(encodeMsg, () => {
        if (MsrpSdk.Config.traceMsrp) {
          MsrpSdk.Logger.info(`[SocketHandler]: MSRP sent (${socket.socketInfo}) - \r\n${encodeMsg}`);
        }
      });
    }

    if (isSuccess) {
      // We may have to send a Success Report even if we don't send a response
      sendReport(socket, routePaths, req, status);
    }
  }

  /**
   * Helper function for starting an interval that checks for opened sockets that haven't
   * received any messages for a valid MSRP session.
   */
  function startSocketsAudit() {
    if (socketsAuditInterval) {
      return;
    }
    socketsAuditInterval = setInterval(() => {
      const oldestTimestamp = Date.now() - PENDING_SOCKET_TIMEOUT;
      for (const [socket, timestamp] of pendingAssociations) {
        if (timestamp < oldestTimestamp) {
          MsrpSdk.Logger.warn(`[SocketHandler]: Timed out waiting for socket ${socket.socketInfo} to be associated with MSRP session`);
          socket.destroy();
          pendingAssociations.delete(socket);
        }
      }

      if (!pendingAssociations.size) {
        clearInterval(socketsAuditInterval);
        socketsAuditInterval = null;
      }
    }, AUDIT_INTERVAL);
  }

  /**
   * Helper function for starting the receiver check interval if it's not already running.
   * This function also takes care of stopping the interval when it is done.
   * The receiver check interval is responsible for checking stale ChunkReceivers and stale pending reports.
   */
  function startCheckInterval() {
    if (receiverCheckInterval) {
      return;
    }
    receiverCheckInterval = setInterval(() => {
      const oldestTimestamp = Date.now() - RCV_TIMEOUT;
      for (const [messageId, receiver] of chunkReceivers) {
        if (receiver.lastReceive < oldestTimestamp) {
          MsrpSdk.Logger.warn(`[SocketHandler]: Timed out waiting for chunks for ${messageId}`);
          // Clean up the receiver
          receiver.abort();
          chunkReceivers.delete(messageId);
          MsrpSdk.Logger.debug(`[SocketHandler]: Removed receiver for ${messageId}. Num active receivers: ${chunkReceivers.size}`);
        }
      }

      for (const [messageId, pendingData] of pendingReports) {
        if (pendingData.timestamp < oldestTimestamp) {
          MsrpSdk.Logger.warn(`[SocketHandler]: Timed out waiting to send report for ${messageId}`);
          sendPendingReport(messageId, MsrpSdk.Status.REQUEST_TIMEOUT);
          MsrpSdk.Logger.debug(`[SocketHandler]: Sent report for ${messageId}. Num pending reports: ${chunkReceivers.size}`);
        }
      }

      // Stop the receiver poll when done receiving chunks / sending reports
      if (chunkReceivers.size === 0 && pendingReports.size === 0) {
        clearInterval(receiverCheckInterval);
        receiverCheckInterval = null;
      }
    }, AUDIT_INTERVAL);
  }

  MsrpSdk.SocketHandler = SocketHandler;
};
