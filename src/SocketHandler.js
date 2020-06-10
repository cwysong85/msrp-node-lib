'use strict';

// eslint-disable-next-line max-lines-per-function
module.exports = function (MsrpSdk) {

  const MSRP_REGEX = /MSRP (\S+) [\s\S]*?\r\n-{7}\1[$#+]\r\n/g;

  const RCV_TIMEOUT = 30000; // 30 seconds
  const MAX_BUFFERED_DATA = 1024 * 1024; // 1 MB

  // Private variables
  const chunkReceivers = new Map();
  const chunkSenders = new Map();

  const activeSenders = [];
  let receiverCheckInterval = null;
  let senderTimeout = null;

  function getSocketInfo(socket) {
    const socketAddr = socket.address() || {};
    const local = `${socketAddr.address}:${socketAddr.port}`;
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    return `Local address: ${local}, Remote address: ${remote}`;
  }

  /**
   * Socket handler
   * @param {object} socket Socket
   */
  const SocketHandler = function (socket) {
    let socketInfo = '';
    let bufferedData = '';

    // Set socket encoding so we get Strings in the 'data' event
    socket.setEncoding('utf8');

    // Set socket timeout as needed
    if (MsrpSdk.Config.socketTimeout > 0) {
      MsrpSdk.Logger.debug(`[SocketHandler]: Setting socket timeout to ${MsrpSdk.Config.socketTimeout}`);
      socket.setTimeout(MsrpSdk.Config.socketTimeout);
    }

    // Socket events:
    if (socket.writable || socket.readable) {
      // Socket is already connected
      socketInfo = getSocketInfo(socket);
      MsrpSdk.Logger.info(`[Server]: Socket connected. ${socketInfo}`);
    } else {
      socket.on('connect', () => {
        socketInfo = getSocketInfo(socket);
        MsrpSdk.Logger.info(`[Server]: Socket connected. ${socketInfo}`);
      });
    }

    socket.on('timeout', () => {
      MsrpSdk.Logger.warn(`[Server]: Socket timeout. ${socketInfo || getSocketInfo(socket)}`);
    });

    socket.on('error', error => {
      MsrpSdk.Logger.error(`[Server]: Socket error. ${socketInfo || getSocketInfo(socket)}.`, error);
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
            MsrpSdk.Logger.info(`[SocketHandler]: MSRP received:\r\n${MsrpSdk.Util.obfuscateMessage(message)}`);
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
      MsrpSdk.Logger.info(`[Server]: Socket closed. ${socketInfo}`);
    });

    /**
     * Helper function for sending messages via a specific socket.
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
        MsrpSdk.Logger.debug(`[SocketHandler]: Removed sender for ${messageId}. Num active senders: ${chunkSenders.size}`);

        if (typeof onReportReceived === 'function') {
          onReportReceived(status, messageId);
        }
      });

      chunkSenders.set(sender.messageId, sender);
      MsrpSdk.Logger.debug(`[SocketHandler]: Created new sender for ${sender.messageId}. Num active senders: ${chunkSenders.size}`);

      // Logic for keeping track of sent heartbeats
      if (message.contentType === 'text/x-msrp-heartbeat') {
        session.heartbeatsTransIds[sender.nextTid] = Date.now();
        MsrpSdk.Logger.debug(`[SocketHandler]: MSRP heartbeat sent to ${session.remoteEndpoints} (tid: ${sender.nextTid})`);
      }

      activeSenders.push({
        sender,
        socket,
        onMessageSent
      });

      sendRequests();
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

    if (request.fromPath[0] !== session.remoteEndpoints[0]) {
      sendResponse(request, socket, toUri.uri, MsrpSdk.Status.SESSION_DOES_NOT_EXIST, 'Invalid From-Path');
      return;
    }

    // Set session socket if there is no current socket set
    if (!session.socket || session.socket.destroyed) {
      session.setSocket(socket);
    }

    // If there is a socket in use, but a new socket is connected, add a listener so the new socket is used as soon as the current socket is closed
    if (socket.remoteAddress !== session.socket.remoteAddress || socket.remotePort !== session.socket.remotePort) {
      session.socket.on('close', () => {
        session.setSocket(socket);
      });
    }

    switch (request.method) {
      case 'REPORT':
        incomingReport(request);
        break;
      case 'SEND':
        incomingSend(request, socket, session, toUri);
        break;
      default:
        // If the request method is not understood, return 501 NOT IMPLEMENTED
        sendResponse(request, socket, toUri.uri, MsrpSdk.Status.NOT_IMPLEMENTED);
        break;
    }
  }

  /**
   * Helper function for handling incoming responses
   * Only responses to heartbeats are being handled. The rest responses are ignored.
   * @param {object} response Response
   */
  function handleIncomingResponse(response) {
    // Retrieve Session
    const toUri = new MsrpSdk.URI(response.toPath[0]);
    const session = MsrpSdk.SessionController.getSession(toUri.sessionId);

    // Check if it is a heartbeat response and handle it as needed
    const isHeartbeatResponse = response.tid && session && session.heartbeatsTransIds[response.tid];
    if (isHeartbeatResponse) {
      if (response.status === 200) {
        // If the response is 200OK, clear all the stored heartbeats
        MsrpSdk.Logger.debug(`[SocketHandler]: MSRP heartbeat response received from ${response.fromPath} (tid: ${response.tid})`);
        session.heartbeatsTransIds = {};
      } else if (response.status >= 400) {
        // If not okay, emit 'heartbeatFailure'
        MsrpSdk.Logger.debug(`[SocketHandler]: MSRP heartbeat error received from ${response.fromPath} (tid: ${response.tid})`);
        session.emit('heartbeatFailure', session);
      }
    }

    // TODO: Handle other incoming responses. Ticket: https://github.com/cwysong85/msrp-node-lib/issues/16
  }

  /**
   * Helper function for handling incoming reports
   * @param {object} report Report
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
    const connectionMode = session.remoteSdp.getMsrpConnectionMode();
    if (connectionMode === 'recvonly' || connectionMode === 'inactive') {
      MsrpSdk.Logger.warn(`[SocketHandler]: MSRP data is not allowed when session requested "a=${connectionMode}" in SDP`);
      sendResponse(request, socket, toUri.uri, MsrpSdk.Status.FORBIDDEN);
      return;
    }

    // Non-chunked messages
    if (request.isComplete()) {
      // Emit 'message' event. Do not emit it for heartbeat messages or bodiless messages.
      const isHeartbeatMessage = request.contentType === 'text/x-msrp-heartbeat';
      const isBodilessMessage = !request.body && !request.contentType;
      if (!isHeartbeatMessage && !isBodilessMessage) {
        try {
          session.emit('message', request, session);
        } catch (err) {
          MsrpSdk.Logger.error('[SocketHandler]: Error raising "message" event.', err);
        }
      }
      // Return successful response: 200 OK
      sendResponse(request, socket, toUri.uri, MsrpSdk.Status.OK);
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
      startChunkReceiverPoll();
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

    // If it is the last chunk, parse the message body and clean up the receiver
    if (receiver.isComplete()) {
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
      // Emit 'message' event including the complete message
      session.emit('message', request, session);
    }
    // Return successful response: 200 OK
    sendResponse(request, socket, toUri.uri, MsrpSdk.Status.OK);
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
      report.addHeader('Message-ID', req.messageId);
      report.addHeader('Status', statusHeader);
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

      const encodeMsg = report.encode();
      socket.write(encodeMsg);
      if (MsrpSdk.Config.traceMsrp) {
        MsrpSdk.Logger.info(`[SocketHandler]: MSRP sent:\r\n${encodeMsg}`);
      }
    } catch (err) {
      MsrpSdk.Logger.error('[SocketHandler]: Error sending report.', err);
    }
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
    socket.write(encodeMsg);
    if (MsrpSdk.Config.traceMsrp) {
      MsrpSdk.Logger.info(`[SocketHandler]: MSRP sent:\r\n${MsrpSdk.Util.obfuscateMessage(encodeMsg)}`);
    }

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
      try {
        sendNextRequest();
      } catch (err) {
        MsrpSdk.Logger.error('[SocketHandler]: Failed to send request.', err);
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
      MsrpSdk.Logger.error('[SocketHandler]: Unable to send response/report. Socket is destroyed.');
      return;
    }

    if (!socket.writable) {
      MsrpSdk.Logger.warn('[SocketHandler]: Unable to send response/report. Socket is not writable.');
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
          MsrpSdk.Logger.info(`[SocketHandler]: MSRP sent:\r\n${encodeMsg}`);
        }
        // Now that we sent the response, we may need to also send a REPORT.
        sendReport(socket, routePaths, req, status);
      });
    } else {
      // There was no need to send a response, but we may need to send a REPORT.
      sendReport(socket, routePaths, req, status);
    }
  }

  /**
   * Helper function for starting the chunk receiver poll if it's not already running.
   * This function also takes care of stopping the chunk receiver poll when it is done receiving.
   */
  function startChunkReceiverPoll() {
    if (receiverCheckInterval) {
      return;
    }
    receiverCheckInterval = setInterval(() => {
      const oldestTimestamp = Date.now() - RCV_TIMEOUT; // 30 seconds ago
      for (const [messageId, receiver] of chunkReceivers) {
        if (receiver.lastReceive < oldestTimestamp) {
          MsrpSdk.Logger.warn(`[SocketHandler]: Timed out waiting for chunks for ${messageId}`);
          // Clean up the receiver
          receiver.abort();
          chunkReceivers.delete(messageId);
          MsrpSdk.Logger.debug(`[SocketHandler]: Removed receiver for ${messageId}. Num active receivers: ${chunkReceivers.size}`);
        }
      }
      // Stop the receiver poll when done receiving
      if (chunkReceivers.size === 0) {
        clearInterval(receiverCheckInterval);
        receiverCheckInterval = null;
      }
    }, RCV_TIMEOUT / 2);
  }

  MsrpSdk.SocketHandler = SocketHandler;
};
