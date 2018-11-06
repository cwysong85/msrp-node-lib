var util = require('util');
var EventEmitter = require('events').EventEmitter;

module.exports = function(MsrpSdk) {
    var config = MsrpSdk.Config;
    var msrpTracingEnabled = config.traceMsrp;
    var chunkReceivers = {},
        receiverCheckInterval = null,
        chunkSenders = {},
        activeSenders = [],
        outstandingSends = 0;

    var SocketHandler = function(socket) {
        var socketHandler = this;
        var session; // Stores the session for the current socket

        socket._msrpDataBuffer = new Buffer(0);

        socket.on('data', function(data) {

            // Send to tracing function
            traceMsrp(data);

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

            // are the toPath and fromPath the same? We need to drop this data if so...
            if (msg.toPath[0] === msg.fromPath[0]) return

            socket._msrpDataBuffer = new Buffer(0);


            // is this a report?
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
                sendResponse(msg, socket, toUri.uri, MsrpSdk.Status.SESSION_DOES_NOT_EXIST);
                return;
            }

            // have we started heart beats yet and is this a passive session?
            if (session.weArePassive && session.heartBeat) {
                session.startHeartBeat(session.heartBeatInterval)
            }

            // if this is a response to a heartbeat
            if (msg.tid && session.heartBeatTransIds[msg.tid] != undefined) {
                MsrpSdk.Logger.debug(`MSRP heartbeat Response received ${msg.tid}`);

                // MsrpSdk.Logger.debug(msg);
                // is the response good?
                if (msg.status === 200) {
                    setTimeout(function() {
                        session.heartBeatTransIds = {}
                    }, 500) // (BA) timeout is a workaround, until TCC is fixed
                } else if (msg.status >= 500) { // if not okay, close session
                    // Should we close session, or account for other response codes?
                    session.emit('socketClose', true, session);
                    return;
                }
            }

            // if response, don't worry about it
            if (msg.status === 200) {
                return;
            }

            if (!session.localEndpoint) {
                session.localEndpoint = toUri;
            }

            // we need to assign the socket to the session
            if (!session.socket) {
                session.socket = socket;
                session.emit('socketConnect', session);

                // Is this fromURI in our session already? If not add it
                if (!session.getRemoteEndpoint(fromUri.uri)) {
                    session.addRemoteEndpoint(fromUri.uri);
                }
            }

            // Check for bodiless SEND
            if (msg.method === "SEND" && !msg.body && !msg.contentType) {
                sendResponse(msg, socket, toUri.uri, MsrpSdk.Status.OK);
                return;
            }

            var okStatus = true;
            try {
                if (msg.byteRange.start === 1 && msg.continuationFlag === MsrpSdk.Message.Flag.end) {
                    // Non chunked message
                    session.emit('message', msg, session);
                } else {
                    // Chunk of a multiple-chunk message
                    var msgId = msg.messageId,
                        description, filename;

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

                            session.emit('message', msg);

                        } else {
                            // Receive ongoing
                            MsrpSdk.Logger.info('Receiving additional chunks for MsgId: ' + msgId + ', bytesReceived: ' + chunkReceivers[msgId].receivedBytes);
                        }
                    }
                }
            } catch (e) {
                // Send an error response, but check which status to return
                var status = MsrpSdk.Status.INTERNAL_SERVER_ERROR;
                if (e instanceof MsrpSdk.Exceptions.UnsupportedMedia) {
                    status = MsrpSdk.Status.UNSUPPORTED_MEDIA;
                } else {
                    MsrpSdk.Logger.warn('Unexpected application exception: ' + e.stack);
                }
                sendResponse(msg, socket, toUri.uri, status);
                return;
            }

            if (okStatus) {
                sendResponse(msg, socket, toUri.uri, MsrpSdk.Status.OK);
                return;
            }


        });

        socket.on('connect', function() {
            MsrpSdk.Logger.info('Socket connect');
            // TODO: This listener should emit the 'socketConnect' event.
            // The other 'socketConnect' event emitted by the SocketHandler is actually
            // something like a 'bodylessMessageReceived' event.
            // Since we are supporting inbound connections both are not the same anymore.
        });

        socket.on('timeout', function() {
            MsrpSdk.Logger.warn('Socket timeout');
            if (session) {
                session.emit('socketTimeout', session);
            }
        });

        socket.on('error', function(error) {
            MsrpSdk.Logger.warn('Socket error');
            if (session) {
                session.emit('socketError', error, session);
            }
        });

        socket.on('close', function(hadError) {
            MsrpSdk.Logger.warn('Socket close');
            if (session) {
                session.emit('socketClose', hadError, session);
            }
        });

        socket.on('end', function() {
            MsrpSdk.Logger.info('Socket ended');
            if (session) {
                session.emit('socketEnd', session);
            }
        });

        socket.on('send', function(message, routePaths, cb) {
            if (!message || !routePaths) {
                return;
            }

            var sender = new MsrpSdk.ChunkSender(routePaths, message.body, message.contentType);
            var date = new Date
            if (message.contentType === "text/x-msrp-heartbeat" && session.heartBeat) {
                session.heartBeatTransIds[sender.tid] = date.getTime()
                MsrpSdk.Logger.debug(`MSRP heartbeat sent ${sender.tid}`);
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

    var traceMsrp = function(data) {
        if (!data || !msrpTracingEnabled) return;
        var print = '';
        if (data instanceof String || typeof data === 'string') {
            print += data;
        } else if (data instanceof Buffer) {
            print += String.fromCharCode.apply(null, new Uint8Array(data));
        } else {
            return MsrpSdk.Logger.warn('[Server traceMsrp] Cannot trace MSRP. Unsupported data type');
        }
        MsrpSdk.Logger.info(print);
    };

    var sendResponse = function(req, socket, toUri, status) {
        var msg = new MsrpSdk.Message.OutgoingResponse(req, toUri, status);
        var encodeMsg = msg.encode();

        // Write message to socket
        socket.write(encodeMsg, function() {
            // If request has header 'success-report', send back a report
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

        // trace msrp message
        traceMsrp(encodeMsg);
    };

    var incomingReport = function(report) {
        var msgId, sender;

        msgId = report.messageId;
        if (!msgId) {
            MsrpSdk.Logger.info('Invalid REPORT: no message id');
            return;
        }

        // Check whether this is for a chunk sender first
        sender = chunkSenders[msgId];
        if (!sender) {
            MsrpSdk.Logger.info('Invalid REPORT: unknown message id');
            // Silently ignore, as suggested in 4975 section 7.1.2
            return;
        }

        // Let the chunk sender handle the report
        sender.processReport(report);
        if (!sender.isComplete()) {
            // Still expecting more reports, no notification yet
            return;
        }

        // All chunks have been acknowledged; clean up
        delete chunkSenders[msgId];

        // Don't notify for locally aborted messages
        if (sender.aborted && !sender.remoteAbort) {
            return;
        }
    };

    var sendRequests = function() {

        while (activeSenders.length > 0) {
            // Use first sender in list
            var sender = activeSenders[0].sender,
                socket = activeSenders[0].socket,
                cb = activeSenders[0].cb;

            // abort sending?
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
                cb();
            } else if (activeSenders.length > 1) {
                // For fairness, move this sender to the end of the queue
                activeSenders.push(activeSenders.shift());
            }
        }
    };

    var sendReport = function(socket, session, req, status) {
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
            var start = 1,
                end, total = -1;
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
                MsrpSdk.Logger.warn('Report Byte-Range end does not match request');
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
    };

    MsrpSdk.SocketHandler = SocketHandler;
};