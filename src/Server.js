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

    this.server = net.createServer(function(socket) {
      socket = new MsrpSdk.SocketHandler(socket);
    });
  };

  util.inherits(Server, EventEmitter);

  Server.prototype.start = function(callback) {
    var server = this;
    this.server.listen(config.port, config.host, function() {
      var serv = server.server.address();
      MsrpSdk.Logger.info('MSRP TCP server listening on ' + serv.address + ':' + serv.port);
      if (msrpTracingEnabled) {
        MsrpSdk.Logger.info('MSRP tracing enabled');
      }

      if (callback) {
        callback();
      }
    }).on('error', function(error) {
      MsrpSdk.Logger.warn(error);
      if (callback) {
        callback(error);
      }
    });
  };

  MsrpSdk.Server = Server;
};
