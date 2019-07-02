// Dependencies
var net = require('net');
var util = require('util');
var EventEmitter = require('events').EventEmitter;

module.exports = function(MsrpSdk) {
  /**
   * MSRP server
   * @property server MSRP server
   */
  var Server = function() {
    this.server = net.createServer(function(socket) {
      new MsrpSdk.SocketHandler(socket);
    });
  };
  util.inherits(Server, EventEmitter);

  /**
   * Starts the MSRP server
   * @param  {Function} callback Callback function
   */
  Server.prototype.start = function(callback) {
    var server = this;
    server.server.listen(MsrpSdk.Config.port, MsrpSdk.Config.host, function() {
      var serverAddress = server.server.address();
      MsrpSdk.Logger.info(`[MSRP Server] MSRP TCP server listening on ${serverAddress.address}:${serverAddress.port}`);
      if (MsrpSdk.Config.traceMsrp) {
        MsrpSdk.Logger.info('[MSRP Server] MSRP tracing enabled');
      }
      if (callback) {
        callback();
      }
    }).on('error', function(error) {
      MsrpSdk.Logger.error(error);
      if (callback) {
        callback(error);
      }
    });
  };

  MsrpSdk.Server = Server;
};
