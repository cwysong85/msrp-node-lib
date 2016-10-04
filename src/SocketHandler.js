var util = require('util');
var EventEmitter = require('events').EventEmitter;

module.exports = function(MsrpSdk) {
  var config = MsrpSdk.Config;
  var msrpTracingEnabled = config.traceMsrp;

  var SocketHandler = function(socket) {
    var socketHandler = this;
    var session; // Stores the session for the current socket

    socket.on('data', function(data) {
      // Send to tracing function
      traceMsrp(data);

      // Parse MSRP message
      var msg = MsrpSdk.parseMessage(data);

      if (!msg) {
        // TODO: (LVM) Do we need to do something else here?
        console.warn('Could not parse MSRP message');
        return;
      }

      // The toUri contains our sessionId
      var toUri = new MsrpSdk.URI(msg.toPath[0]);
      var fromUri = new MsrpSdk.URI(msg.fromPath[0]);

      // Check if toUri is not null
      if (!toUri) {
        sendResponse(msg, socket, toUri.uri, MsrpSdk.Status.BAD_REQUEST);
        return;
      }

      session = MsrpSdk.SessionController.getSession(toUri.sessionId);

      // Check if the session exists and return forbidden if it doesn't
      if (!session) {
        sendResponse(msg, socket, toUri.uri, MsrpSdk.Status.SESSION_DOES_NOT_EXIST);
        return;
      }

      if (!session.localEndpoint) {
        session.localEndpoint = toUri;
      }

      // Check for bodiless SEND
      if (msg.method === "SEND" && !msg.body && !msg.contentType) {
        session.socket = socket;
        session.emit('socketConnect', session);

        // Is this fromURI in our session already? If not add it
        if (!session.getRemoteEndpoint(fromUri.uri)) {
          session.addRemoteEndpoint(fromUri.uri);
        }

        sendResponse(msg, socket, toUri.uri, MsrpSdk.Status.OK);

        if (msg.getHeader('success-report') === 'yes') {
          sendReport(socket, {
            toPath: msg.fromPath,
            localUri: toUri.uri
          }, msg);
        }

        return;
      }

      // If response, emit response
      if (msg.status === MsrpSdk.Status.OK) { // TODO: (LVM) Forward all responses, not only 200 OKs, right?
        session.emit('respose', msg, session);
        return;
      } else {
        // Send 200 OK to MSRP client
        sendResponse(msg, socket, toUri.uri, MsrpSdk.Status.OK); // (LVM): toURi or fromUri?
      }

      // TODO: (LVM) Is it OK to send the report here? Before, it was a callback.
      if (msg.getHeader('success-report') === 'yes') {
        sendReport(socket, {
          toPath: msg.fromPath,
          localUri: toUri.uri
        }, msg);
      }

      // Emit message
      session.emit('message', msg, session);
    });

    socket.on('connect', function() {
      console.debug('Socket connect');
      // TODO: This listener should emit the 'socketConnect' event.
      // The other 'socketConnect' event emitted by the SocketHandler is actually
      // something like a 'bodylessMessageReceived' event.
      // Since we are supporting inbound connections both are not the same anymore.
    });

    socket.on('timeout', function() {
      console.warn('Socket timeout');
      session.emit('socketTimeout', session);
    });

    socket.on('error', function(error) {
      console.warn('Socket error');
      session.emit('socketError', error, session);
    });

    socket.on('close', function(hadError) {
      console.warn('Socket close');
      session.emit('socketClose', hadError, session);
    });

    socket.on('end', function() {
      console.debug('Socket ended');
      if (session) {
        session.emit('socketEnd', session);
      }
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
      return console.warn('[Server traceMsrp] Cannot trace MSRP. Unsupported data type');
    }
    console.debug(print);
  };

  function sendResponse(req, socket, uri, status) {
    var msg = new MsrpSdk.Message.OutgoingResponse(req, uri, status);
    var msgToString = msg.encode();
    socket.write(msgToString);
    traceMsrp(msgToString);
  }

  var sendReport = function(socket, session, req) {
    var report;

    report = new MsrpSdk.Message.OutgoingRequest(session, 'REPORT');
    report.addHeader('message-id', req.messageId);
    report.addHeader('status', '000 200 OK');

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
        end = start + req.body.length - 1;
      }

      if (end !== req.byteRange.end) {
        console.warn('Report Byte-Range end does not match request');
      }

      report.byteRange = {
        'start': start,
        'end': end,
        'total': total
      };
    }

    var reportToString = report.encode();
    socket.write(reportToString);
    traceMsrp(reportToString);
  };

  MsrpSdk.SocketHandler = SocketHandler;
};
