'use strict';

// Dependencies
const net = require('net');
const portfinder = require('portfinder');
const { EventEmitter } = require('events');

// eslint-disable-next-line max-lines-per-function
module.exports = function (MsrpSdk) {
  // Load configuration
  const configuredBasePort = MsrpSdk.Config.outboundBasePort || 49152;
  const configuredHighestPort = MsrpSdk.Config.outboundHighestPort || 65535;

  /**
   * MSRP Session
   * @class
   * @property {String} sid Session ID
   * @property {Object} localEndpoint URI object describing the local endpoint
   * @property {Array<String>} remoteEndpoints Array of remote endpoints
   * @property {Object} localSdp SDP object contanining the local SDP
   * @property {Object} remoteSdp SDP object contanining the remote SDP
   * @property {Object} socket Session socket
   * @property {Boolean} updated Flag indicating if Session has been updated since it was initially created
   * @property {Boolean} ended Flag that indicating if Session is ended
   * @property {Object} heartbeatsTransIds Dictionary of heartbeats transaction IDs
   * @property {Function} heartbeatPingFunc Ping function for heartbeats
   * @property {Function} heartbeatTimeoutFunc Timeout function for heartbeats
   * @property {Boolean} setHasNotRan Flag indicating if setDescription has already been called during the SDP negotiation
   * @property {Boolean} getHasNotRan Flag indicating if getDescription has already been called during the SDP negotiation
   */
  class Session extends EventEmitter {
    constructor() {
      super();

      this.sid = MsrpSdk.Util.newSID();
      this.localEndpoint = null;
      this.remoteEndpoints = [];
      this.localSdp = null;
      this.remoteSdp = null;
      this.socket = null;
      this.updated = false;
      this.ended = false;
      this.heartbeatsTransIds = {};
      this.heartbeatPingFunc = null;
      this.heartbeatTimeoutFunc = null;
      this.setHasNotRan = true;
      this.getHasNotRan = true;
    }

    /**
     * Sends an MSRP Message to the Session's remote party
     * @param  {String}   body        Message body
     * @param  {Function} callback    Callback function
     * @param  {String}   contentType Message Content-Type
     */
    sendMessage(body, callback, contentType) {
      // Check if the remote endpoint will accept the message by checking its SDP
      contentType = contentType || 'text/plain';
      // Get the wildcard type, e.g. text/*
      const wildcardContentType = contentType.replace(/\/.*$/, '/*');
      let canSend = this.remoteSdp.attributes['accept-types'].some(acceptType =>
        acceptType === contentType || acceptType === wildcardContentType || acceptType === '*');

      if (this.remoteSdp.attributes.sendonly || this.remoteSdp.attributes.inactive) {
        canSend = false;
      }

      if (this.remoteSdp.media && this.remoteSdp.media[0] && this.remoteSdp.media[0].attributes) {
        if (this.remoteSdp.media[0].attributes.sendonly) {
          canSend = false;
        }
      }

      if (canSend) {
        if (this.socket) {
          this.socket.sendMessage(this, {
            body,
            contentType
          }, {
            toPath: this.remoteEndpoints,
            localUri: this.localEndpoint.uri
          }, callback);
        } else {
          // We don't have a socket. Did the other side send a connection?
          MsrpSdk.Logger.error('[Session]: Cannot send message because there is not an active socket! Did the remote side connect? Check a=setup line in SDP media.');
        }
      } else {
        MsrpSdk.Logger.warn('[Session]: Cannot send message due to remote endpoint SDP attributes');
      }
    }

    /**
     * Function called during the SDP negotiation to create the local SDP.
     * @param  {Function} onSuccess onSuccess callback
     * @param  {Function} onFailure onFailure callback
     */
    getDescription(onSuccess, onFailure) {
      MsrpSdk.Logger.debug('[Session]: Creating local SDP...');

      // Create and configure local SDP
      const localSdp = new MsrpSdk.Sdp.Session();
      // Origin
      localSdp.origin.id = MsrpSdk.Util.dateToNtpTime();
      localSdp.origin.version = localSdp.origin.id;
      localSdp.origin.address = MsrpSdk.Config.signalingHost;
      // Session-name
      localSdp.sessionName = MsrpSdk.Config.sessionName;
      // Connection address
      localSdp.connection.address = MsrpSdk.Config.signalingHost;
      // Accept-types
      localSdp.addAttribute('accept-types', MsrpSdk.Config.acceptTypes);
      // Setup
      if (this.remoteSdp) {
        if (this.remoteSdp.attributes.setup) {
          if (this.remoteSdp.attributes.setup[0] === 'active' || this.remoteSdp.attributes.setup[0] === 'actpass') {
            localSdp.addAttribute('setup', 'passive');
          } else if (this.remoteSdp.attributes.setup[0] === 'passive') {
            localSdp.addAttribute('setup', 'active');
          } else {
            MsrpSdk.Logger.error('[Session]: Invalid remote a=setup value');
            onFailure('Invalid remote a=setup value');
            return;
          }
        } else {
          localSdp.addAttribute('setup', 'passive');
        }
      } else {
        localSdp.addAttribute('setup', MsrpSdk.Config.setup === 'passive' ? 'passive' : 'active');
      }

      // Get the assigned local port for configuring the path and the port
      const session = this;
      getAssignedPort(localSdp.attributes.setup[0])
        .then(assignedPort => {
          // Path
          const path = `msrp://${MsrpSdk.Config.signalingHost}:${assignedPort}/${session.sid};tcp`;
          localSdp.addAttribute('path', path);
          // Port
          localSdp.media.push(`message ${assignedPort} TCP/MSRP *`);

          // Success! Send local SDP
          onSuccess(localSdp.toString());

          // Update session information
          session.localSdp = localSdp;
          session.localEndpoint = new MsrpSdk.URI(path);
          session.getHasNotRan = false;

          // Extra logic for session updates
          let callback;
          if (session.updated) {
            // Emit update event after calling startConnection
            callback = function () {
              session.emit('update', session);
            };
          }

          // Start connection if needed
          session.startConnection(callback);
        })
        .catch(error => {
          MsrpSdk.Logger.error(`[Session]: An error ocurred while creating the local SDP: ${error.toString()}`);
        });
    }

    /**
     * Function called during the SDP negotiation to set the remote SDP.
     * @param  {String}   description Remote description
     * @param  {Function} onSuccess   onSuccess callback
     * @param  {Function} onFailure   onFailure callback
     */
    setDescription(description, onSuccess, onFailure) {
      MsrpSdk.Logger.debug('[Session]: Processing remote SDP...');

      // Parse received SDP
      const remoteSdp = new MsrpSdk.Sdp.Session(description);

      // Retrieve MSRP media attributes
      const remoteMsrpMedia = remoteSdp.media.find(mediaObject => mediaObject.proto.includes('/MSRP'));
      remoteSdp.attributes = remoteMsrpMedia.attributes;

      // Path check
      if (!remoteSdp.attributes.path) {
        MsrpSdk.Logger.error('[Session]: Path attribute missing in remote endpoint SDP');
        onFailure('Path attribute missing in remote endpoint SDP');
        return;
      }

      // If we are updating an existing session, enable updated flag and close existing socket when needed
      if (this.remoteSdp) {
        this.updated = true;
        if (this.socket) {
          if (remoteSdp.attributes.path !== this.remoteSdp.attributes.path) {
            MsrpSdk.Logger.debug(`[Session]: Remote path updated: ${this.remoteSdp.attributes.path.join(' ')} -> ${remoteSdp.attributes.path.join(' ')}`);
            this.closeSocket();
          }
          if (remoteSdp.attributes.inactive) {
            MsrpSdk.Logger.debug('[Session]: Remote party connection changed to inactive');
            this.closeSocket();
          }
        }
      }

      // Update session information
      this.remoteSdp = remoteSdp;
      this.remoteEndpoints = remoteSdp.attributes.path;
      this.setHasNotRan = false;

      // Success! Remote SDP processed
      onSuccess();

      // Start connection if needed
      this.startConnection();
    }

    /**
     * Ends a session
     */
    end() {
      try {
        // Return if session is already ended
        if (this.ended) {
          MsrpSdk.Logger.warn(`[Session]: MSRP session ${this.sid} already ended`);
          return;
        }

        MsrpSdk.Logger.info(`[Session]: Ending MSRP session ${this.sid}...`);
        // Stop heartbeats if needed
        if (MsrpSdk.Config.enableHeartbeats !== false) {
          this.stopHeartbeats();
        }
        // Close socket if needed
        if (this.socket) {
          this.closeSocket();
        }
        // Set ended flag to true
        this.ended = true;

        // Emit 'end' event
        this.emit('end', this);

        // Remove all event listeners
        this.removeAllListeners();
      } catch (e) {
        MsrpSdk.Logger.error(`[Session]: Exception ending MSRP session ${this.sid}.`, e);
      }
    }

    /**
     * Sets the session's socket and and the needed socket event listeners
     * @param  {Object} socket Socket
     */
    setSocket(socket) {
      this.socket = socket;

      // TODO: Add origin check. Ticket: https://github.com/cwysong85/msrp-node-lib/issues/20

      // Forward socket events
      this._onSocketClose = hadError => {
        MsrpSdk.Logger.debug(`[Session]: Received socket close event for session ${this.sid}`);
        this.emit('socketClose', hadError, this);
      };

      this._onSocketError = () => {
        MsrpSdk.Logger.debug(`[Session]: Received socket error event for session ${this.sid}`);
        this.emit('socketError', this);
      };

      this._onSocketTimeout = () => {
        MsrpSdk.Logger.debug(`[Session]: Received socket timeout event for session ${this.sid}`);
        this.emit('socketTimeout', this);
      };

      socket.on('close', this._onSocketClose);
      socket.on('error', this._onSocketError);
      socket.on('timeout', this._onSocketTimeout);

      // Emit socketSet event
      this.emit('socketSet', this);
    }

    /**
     * Closes a session socket
     */
    closeSocket() {
      if (this.socket) {
        // Unregister from socket events
        this.socket.removeListener('close', this._onSocketClose);
        this.socket.removeListener('error', this._onSocketError);
        this.socket.removeListener('timeout', this._onSocketTimeout);

        // Check if the session socket is being reused by other session
        const isSocketReused = MsrpSdk.SessionController.isSocketReused(this);

        // Close the socket if it is not being reused by other session
        if (isSocketReused) {
          MsrpSdk.Logger.info(`[Session]: Socket for session ${this.sid} is being reused. Do not close it.`);
        } else {
          MsrpSdk.Logger.info(`[Session]: Closing socket for session ${this.sid}...`);
          this.socket.end();
        }

        // Clean the session socket attribute
        this.socket = null;
        MsrpSdk.Logger.debug(`[Session]: Removed socket for session ${this.sid}...`);
      }
    }

    /**
     * Stops MSRP heartbeats
     */
    stopHeartbeats() {
      MsrpSdk.Logger.debug(`[Session]: Stopping MSRP heartbeats for session ${this.sid}...`);
      clearInterval(this.heartbeatPingFunc);
      clearInterval(this.heartbeatTimeoutFunc);
      this.heartbeatPingFunc = null;
      this.heartbeatTimeoutFunc = null;
    }

    /**
     * Starts MSRP heartbeats
     */
    startHeartbeats() {
      const heartbeatsInterval = MsrpSdk.Config.heartbeatsInterval || 5000;
      const heartbeatsTimeout = MsrpSdk.Config.heartbeatsTimeout || 10000;

      MsrpSdk.Logger.debug(`[Session]: Starting MSRP heartbeats for session ${this.sid}...`);

      // Send heartbeats
      const sendHeartbeat = this.sendMessage.bind(this, 'HEARTBEAT', null, 'text/x-msrp-heartbeat');
      this.heartbeatPingFunc = setInterval(sendHeartbeat, heartbeatsInterval);

      // Look for timeouts every second
      function heartbeatTimeoutMonitor() {
        for (const key in this.heartbeatsTransIds) { // Loop through all stored heartbeats
          if (this.heartbeatsTransIds.hasOwnProperty(key)) { // Check if key has a property
            const diff = Date.now() - this.heartbeatsTransIds[key]; // Get time difference
            if (diff > heartbeatsTimeout) { // If the difference is greater than heartbeatsTimeout
              MsrpSdk.Logger.error(`[Session]: MSRP heartbeat timeout for session ${this.sid}`);
              this.emit('heartbeatTimeout', this);
              delete this.heartbeatsTransIds[key];
            }
          }
        }
      }
      this.heartbeatTimeoutFunc = setInterval(heartbeatTimeoutMonitor, 1000);
    }

    /**
     * Helper function for establishing connections when the SDP negotiation has been completed
     * @param  {Function} callback Callback
     */
    startConnection(callback) {
      // If the SDP negotiation has not been completed, return
      if (this.getHasNotRan || this.setHasNotRan || !this.remoteSdp || !this.localSdp) {
        MsrpSdk.Logger.debug('[Session]: Unable to start connection yet. SDP negotiation in progress.');
        return;
      }

      // If the session has an active connection, return
      if (this.socket && !this.socket.destroyed) {
        MsrpSdk.Logger.warn('[Session]: Session already has an active connection.');
        return;
      }

      // If inactive attribute is present, do not connect
      if (this.remoteSdp.attributes.inactive) {
        MsrpSdk.Logger.warn('[Session]: Found "a=inactive" in remote endpoint SDP. Connection not needed.');
        return;
      }

      // If the local endpoint is active, connect to the remote party
      if (this.localSdp.attributes.setup[0] === 'active') {
        const remoteEndpointUri = new MsrpSdk.URI(this.remoteEndpoints[0]);
        const localEndpointUri = this.localEndpoint;

        // Do nothing if we are trying to connect to ourselves
        if (localEndpointUri.authority === remoteEndpointUri.authority) {
          MsrpSdk.Logger.warn(`[Session]: Not creating a new TCP connection for session ${this.sid} because we would be talking to ourself. Returning...`);
          return;
        }

        // Create socket and connect
        MsrpSdk.Logger.debug(`[Session]: Creating socket for session ${this.sid}...`);
        const socket = new MsrpSdk.SocketHandler(new net.Socket());
        socket.connect({
          host: remoteEndpointUri.authority,
          port: remoteEndpointUri.port,
          localAddress: localEndpointUri.authority,
          localPort: parseInt(localEndpointUri.port, 10)
        }, () => {
          // Assign socket to the session
          this.setSocket(socket);
          // Send bodiless MSRP message
          const request = new MsrpSdk.Message.OutgoingRequest({
            toPath: this.remoteEndpoints,
            localUri: this.localEndpoint.uri
          }, 'SEND');
          try {
            socket.write(request.encode(), () => {
              if (callback) {
                callback();
              }
            });
          } catch (error) {
            MsrpSdk.Logger.error(`[Session]: An error ocurred while sending the initial bodiless MSRP message: ${error.toString()}`);
          }
        });
      }

      // Start heartbeats if enabled and not running yet
      if (MsrpSdk.Config.enableHeartbeats !== false && !this.heartbeatPingFunc && !this.heartbeatTimeoutFunc) {
        this.startHeartbeats();
      }

      // Reset SDP negotiation flags
      this.getHasNotRan = true;
      this.setHasNotRan = true;
    }
  }

  /**
   * Helper function for getting the local port to be used in the session
   * @param  {String} setup Local setup line content
   * @return {Number}       Local port to be used in the session
   */
  function getAssignedPort(setup) {
    if (setup === 'active') {
      const randomBasePort = Math.ceil(Math.random() * (configuredHighestPort - configuredBasePort)) + configuredBasePort;
      return portfinder.getPortPromise({
        port: randomBasePort,
        stopPort: configuredHighestPort
      });
    } else {
      return Promise.resolve(MsrpSdk.Config.port);
    }
  }

  MsrpSdk.Session = Session;
};
