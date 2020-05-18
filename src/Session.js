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
      this.acceptTypes = [];
      this.localSdp = null;
      this.remoteSdp = null;
      this.socket = null;
      this.ended = false;
      this.heartbeatsTransIds = {};
      this.heartbeatPingFunc = null;
      this.heartbeatTimeoutFunc = null;
      this.setHasNotRan = true;
      this.getHasNotRan = true;

      MsrpSdk.SessionController.addSession(this);
    }

    /**
     * Checks if we need to reconnect the socket when a new remote description is received.
     *
     * @param {object} newRemoteSdp - The new remote session description.
     * @returns {boolean} Returns true if socket needs to be reconnected.
     */
    _needsReconnection(newRemoteSdp) {
      if (!this.remoteSdp || !this.socket) {
        return false;
      }
      if (newRemoteSdp.getMsrpConnectionMode() === 'inactive') {
        MsrpSdk.Logger.info('[Session]: Remote party connection mode changed to inactive');
        return true;
      }

      const newMedia = newRemoteSdp.getMsrpMedia();
      const oldMedia = this.remoteSdp.getMsrpMedia();

      const newPath = newMedia.getAttributeValue('path');
      const oldPath = oldMedia.getAttributeValue('path');

      if (newPath !== oldPath) {
        MsrpSdk.Logger.info(`[Session]: Remote path updated: ${oldPath} -> ${newPath}`);
        return true;
      }

      return false;
    }

    _getMediaDescriptions(localMsrpMedia) {
      // Return the corresponding media lines for the saved remote description
      if (!this.remoteSdp) {
        localMsrpMedia.setAttribute('setup', MsrpSdk.Config.setup === 'passive' ? 'passive' : 'active');
        return [localMsrpMedia];
      }
      return this.remoteSdp.media.map(remoteMedia => {
        if (remoteMedia.isMsrp()) {
          const remoteSetup = remoteMedia.getAttributeValue('setup');
          localMsrpMedia.setAttribute('setup', remoteSetup === 'passive' ? 'active' : 'passive');
          return localMsrpMedia;
        }
        // Create corresponding SdpMedia with port 0
        const localMedia = new MsrpSdk.SdpMedia();
        localMedia.media = remoteMedia.media;
        localMedia.port = 0;
        localMedia.proto = remoteMedia.proto;
        localMedia.format = remoteMedia.format;
        return localMedia;
      });
    }

    /**
     * Check if we can send a message with the given content-type.
     * @param {string} [contentType=text/plain] The message content type.
     * @param {boolean} [logReason=false] Log a warning message in case message cannot be sent.
     */
    canSend(contentType = 'text/plain', logReason = false) {
      if (!this.remoteSdp) {
        logReason && MsrpSdk.Logger.warn('[Session]: Cannot send message because there is no remote SDP');
        return false;
      }
      if (!this.socket) {
        logReason && MsrpSdk.Logger.warn('[Session]: Cannot send message because there is no active socket');
        return false;
      }

      const connectionMode = this.remoteSdp.getMsrpConnectionMode();
      if (connectionMode === 'sendonly' || connectionMode === 'inactive') {
        logReason && MsrpSdk.Logger.warn(`[Session]: Cannot send message because remote SDP is ${connectionMode}`);
        return false;
      }

      // Get the wildcard type, e.g. text/*
      const wildcardContentType = contentType.replace(/\/.*$/, '/*');
      const isTypeSupported = this.acceptTypes.some(type =>
        type === contentType || type === wildcardContentType || type === '*');

      if (!isTypeSupported) {
        logReason && MsrpSdk.Logger.warn(`[Session]: Cannot send message because ${contentType} is not supported`);
        return false;
      }

      return true;
    }

    /**
     * Sends an MSRP Message to the Session's remote party.
     * @param {string} body Message body
     * @param {string} [contentType=text/plain] Message Content-Type
     * @param {Function} [onMessageSent] Callback function invoked when request is sent.
     * @param {Function} [onReportReceived] Callback function invoked when report is received.
     * @returns {boolean} Returns true if message has been queued to be sent.
     */
    sendMessage(body, contentType, onMessageSent, onReportReceived) {
      contentType = contentType || 'text/plain';

      if (!this.canSend(contentType, true)) {
        return false;
      }

      const message = { body, contentType };
      this.socket.sendMessage(this, message, onMessageSent, onReportReceived);
      return true;
    }

    /**
     * Function called during the SDP negotiation to create the local SDP.
     * @returns {Promise} Promise with generated session description.
     */
    getDescription() {
      return new Promise((resolve, reject) => {
        let localSdp, msrpMedia;

        MsrpSdk.Logger.debug('[Session]: Creating local SDP...');

        if (this.localSdp) {
          // This is an existing session
          localSdp = this.localSdp;
          // Increment the SDP version
          localSdp.origin.version++;
          // Get current MSRP media
          msrpMedia = localSdp.getMsrpMedia();
        } else {
          // This is a new session. Create new Sdp and SdpMedia objetcs.
          localSdp = new MsrpSdk.Sdp();
          // Origin
          localSdp.origin.id = MsrpSdk.Util.dateToNtpTime();
          localSdp.origin.version = 1;
          localSdp.origin.address = MsrpSdk.Config.signalingHost;
          // Session-name
          localSdp.sessionName = MsrpSdk.Config.sessionName;
        }

        if (!msrpMedia) {
          msrpMedia = new MsrpSdk.SdpMedia();
          // Connection address
          msrpMedia.connection.address = MsrpSdk.Config.signalingHost;
          // Attributes
          msrpMedia.setAttribute('accept-types', MsrpSdk.Config.acceptTypes);
        }

        // Set local media descriptions
        localSdp.media = this._getMediaDescriptions(msrpMedia);

        this.getHasNotRan = false;
        this.localSdp = localSdp;

        if (this.socket && !this.socket.destroyed) {
          MsrpSdk.Logger.debug('[Session]: Session already has an active connection. Just resolve new local description.');
          resolve(localSdp.toString());
          return;
        }

        // Get the assigned local port for configuring the path and the port
        const session = this;
        getAssignedPort(msrpMedia.getAttributeValue('setup'))
          .then(assignedPort => {
            // Path
            const path = `msrp://${MsrpSdk.Config.signalingHost}:${assignedPort}/${session.sid};tcp`;
            msrpMedia.setAttribute('path', path);
            // Port
            msrpMedia.port = assignedPort;

            // Success! Send local SDP
            resolve(localSdp.toString());

            // Update session information
            session.localEndpoint = new MsrpSdk.URI(path);

            // Start connection if needed
            session.startConnection();
          })
          .catch(error => {
            MsrpSdk.Logger.error(`[Session]: An error ocurred while creating the local SDP: ${error.toString()}`);
            this.getHasNotRan = true;
            reject(error);
          });
      });
    }

    /**
     * Function called during the SDP negotiation to set the remote SDP.
     * @param {string} description The remote session description.
     * @returns {Promise} Promise indicating whether operation was successful.
     */
    setDescription(description) {
      return new Promise((resolve, reject) => {

        MsrpSdk.Logger.debug('[Session]: Processing remote SDP...');

        // Parse received SDP
        const remoteSdp = new MsrpSdk.Sdp(description);

        // Retrieve MSRP media attributes
        const msrpMedia = remoteSdp.getMsrpMedia();
        if (!msrpMedia) {
          this.setHasNotRan = false;
          this.closeSocket();
          MsrpSdk.Logger.warn('[Session]: Remote description does not have MSRP');
          resolve();
          return;
        }

        // Path check
        const path = msrpMedia.getAttributeValue('path');
        if (!path) {
          MsrpSdk.Logger.error('[Session]: Path attribute missing in remote endpoint SDP');
          reject('Path attribute missing in remote endpoint SDP');
          return;
        }

        const setup = msrpMedia.getAttributeValue('setup');
        if (setup && !['active', 'actpass', 'passive'].includes(setup)) {
          MsrpSdk.Logger.error('[Session]: Invalid remote a=setup value');
          reject('Invalid remote a=setup value');
          return;
        }

        this.setHasNotRan = false;

        // Check if we need to reconnect the socket
        if (this._needsReconnection(remoteSdp)) {
          this.closeSocket();
        }

        // Update session information
        this.remoteSdp = remoteSdp;
        this.remoteEndpoints = path.split(/\s+/);

        const acceptTypes = msrpMedia.getAttributeValue('accept-types');
        this.acceptTypes = acceptTypes ? acceptTypes.split(/\s+/) : [];

        // Start connection if needed
        this.startConnection();

        resolve();
      });
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
     * @param {object} socket Socket
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
      if (!this.socket) {
        return;
      }
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
      const sendHeartbeat = this.sendMessage.bind(this, 'HEARTBEAT', 'text/x-msrp-heartbeat');
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
     * Helper function for establishing connections when the SDP negotiation has been completed.
     * @param {Function} [callback] Callback invoked when connection is established.
     */
    startConnection(callback) {
      // If the SDP negotiation has not been completed, return
      if (this.getHasNotRan || this.setHasNotRan || !this.remoteSdp || !this.localSdp) {
        MsrpSdk.Logger.debug('[Session]: Unable to start connection yet. SDP negotiation in progress.');
        return;
      }

      if (!this.remoteSdp.hasMsrp()) {
        MsrpSdk.Logger.warn('[Session]: Unable to start connection. Remote SDP does not have MSRP.');
        return;
      }

      // If the session has an active connection, return
      if (this.socket && !this.socket.destroyed) {
        MsrpSdk.Logger.warn('[Session]: Session already has an active connection.');
        return;
      }

      // If inactive attribute is present, do not connect
      if (this.remoteSdp.getMsrpConnectionMode() === 'inactive') {
        MsrpSdk.Logger.warn('[Session]: Found "a=inactive" in remote endpoint SDP. Connection not needed.');
        return;
      }

      // If the local endpoint is active, connect to the remote party
      const msrpMedia = this.localSdp.getMsrpMedia();
      if (!msrpMedia) {
        MsrpSdk.Logger.warn('[Session]: Unable to start connection. Local SDP does not have MSRP.');
        return;
      }

      if (msrpMedia.getAttributeValue('setup') === 'active') {
        const remoteEndpointUri = new MsrpSdk.URI(this.remoteEndpoints[0]);
        const localEndpointUri = this.localEndpoint;

        // Do nothing if we are trying to connect to ourselves
        if (localEndpointUri.authority === remoteEndpointUri.authority) {
          MsrpSdk.Logger.warn(`[Session]: Not creating a new TCP connection for session ${this.sid} because we would be talking to ourself. Returning...`);
          return;
        }

        // Create socket and connect
        MsrpSdk.Logger.debug(`[Session]: Creating socket for session ${this.sid}...`);
        const socket = MsrpSdk.SocketHandler(new net.Socket());
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
            fromPath: [this.localEndpoint.uri]
          }, 'SEND');
          try {
            socket.write(request.encode(), () => {
              if (typeof callback === 'function') {
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
   * @param {string} setup Local setup line content
   * @return {Promise<number>} Local port to be used in the session
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
