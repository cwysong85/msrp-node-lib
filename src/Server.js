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
    this.danglingSockets = [];
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

      // Check if there is a Session waiting for this connection and set the socket
      const session = MsrpSdk.SessionController.getSessionsByRemoteSocketAddress(`${socket.remoteAddress}:${socket.remotePort}`)[0];
      if (session) {
        try {
          session.setSocket(socket);
        } catch (error) {
          MsrpSdk.Logger.error(`[MSRP Server] Error setting socket for session ${session.sid}: ${error}`);
        }
      } else {
        // If not, add the socket to the danglingSockets list. This list will be checked by Session.setupConnection when local party is passive.
        MsrpSdk.Logger.warn(`[MSRP Server] No session found for remote address ${socket.remoteAddress}:${socket.remotePort}. Waiting for session setup...`);
        server.danglingSockets.push(socket);
        // End the socket and remove it from the list after a period of time if it has not been assigned to a session
        setTimeout(() => {
          const socketIndex = server.danglingSockets.indexOf(socket);
          if (socketIndex !== -1) {
            MsrpSdk.Logger.warn(`[MSRP Server] Dangling socket timeout. Socket with address ${socket.remoteAddress}:${socket.remotePort} has not been assigned to any Session. Closing socket...`);
            socket.end();
            server.danglingSockets.splice(socketIndex, 1);
          }
        }, MsrpSdk.Config.danglingSocketTimeout ?? 20000);
      }
    });
  };

  MsrpSdk.Server = new Server();
};
