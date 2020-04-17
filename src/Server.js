'use strict';

// Dependencies
const net = require('net');
const { EventEmitter } = require('events');

module.exports = function (MsrpSdk) {
  /**
   * MSRP server
   */
  class Server extends EventEmitter {
    constructor() {
      super();
      this.server = net.createServer(socket => {
        MsrpSdk.Logger.info(`[Server]: New connection from ${socket.remoteAddress}:${socket.remotePort}`);
        new MsrpSdk.SocketHandler(socket);
      });
    }

    /**
     * Starts the MSRP server
     * @param  {Function} callback Callback function
     */
    start(callback) {
      this.server.listen(MsrpSdk.Config.port, MsrpSdk.Config.host, () => {
        const serverAddress = this.server.address();
        MsrpSdk.Logger.info(`[Server]: MSRP TCP server listening on ${serverAddress.address}:${serverAddress.port}`);
        MsrpSdk.Logger.debug(`[Server]: MSRP tracing ${MsrpSdk.Config.traceMsrp ? 'enabled' : 'disabled'}`);
        if (callback) {
          callback();
        }
      })
        .on('error', error => {
          MsrpSdk.Logger.error('[Server]: Failed to start MSRP server.', error);
          if (callback) {
            callback(error);
          }
        });
    }
  }

  MsrpSdk.Server = Server;
};
