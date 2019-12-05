// Dependencies
const net = require('net');
const util = require('util');
const EventEmitter = require('events').EventEmitter;

module.exports = function(MsrpSdk) {
  /**
   * MSRP server
   * @property server MSRP server
   */
  const Server = function() {
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
    const server = this;
    server.server.listen(MsrpSdk.Config.port, MsrpSdk.Config.host, function() {
      const serverAddress = server.server.address();
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
    }).on('connection', function(socket) {
      MsrpSdk.Logger.debug(`[MSRP Server] Socket connected. Remote address: ${socket.remoteAddress}:${socket.remotePort}`);
    });
  };

  MsrpSdk.Server = Server;
};
