var net = require('net');
var util = require('util');
var EventEmitter = require('events').EventEmitter;

module.exports = function(MsrpSdk) {
  var msrpTracingEnabled = false;
  var config = MsrpSdk.Config;

  /**
   * MSRP server
   * @param  {object} config Holds the MSRP Server configuation
   * @return {object}        The MSRP Server object
   */
  var Server = function() {
    var server = this;
    server.config = config;
    msrpTracingEnabled = config.traceMsrp;

    this.sessions = {};

    this.server = net.createServer(function(socket){
      // TODO: INBOUND -  Remove next line
      console.warn('CALLING SOCKET HANDLER FROM SERVER');

      // TODO: INBOUND - Review this
      socket = new MsrpSdk.SocketHandler(socket);
    });
  };

  // TODO: Is Server emitting something now?
  util.inherits(Server, EventEmitter);

  Server.prototype.start = function() {
    var server = this;
    this.server.listen(config.port, config.host, function() {
      var serv = server.server.address();
      console.info('MSRP TCP server listening on ' + serv.address + ':' + serv.port);
      if (msrpTracingEnabled) {
        console.info('MSRP tracing enabled');
      }
    }).on('error', function(error) {
      console.warn(error);
    });
  };

  Server.prototype.sendMsrpMessage = function(session, body, socket) {
    var req = new MsrpSdk.Message.OutgoingRequest(session, 'SEND');
    req.addTextBody(body);
    var reqToString = req.encode();
    socket.write(reqToString);
    traceMsrp(reqToString);
  };

  Server.prototype.sendError = function(req, socket, error) {
    sendResponse(req, socket, req.toPath, error);
  };

  function sendResponse(req, socket, uri, status) {
    var msg = new MsrpSdk.Message.OutgoingResponse(req, uri, status);
    var msgToString = msg.encode();
    socket.write(msgToString);
    traceMsrp(msgToString);
  }

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

  MsrpSdk.Server = Server;
};
