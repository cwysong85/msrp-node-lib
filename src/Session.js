'use strict';

// Dependencies
const net = require('net');
const { EventEmitter } = require('events');

// eslint-disable-next-line max-lines-per-function
module.exports = function (MsrpSdk) {

  // The following variables are used to put a remote MSRP server in a blocked list for 1 second,
  // if there are 10 ECONNREFUSED errors connecting to the server in an interval of 100 ms.
  const MAX_CONN_REFUSED_PER_INTERVAL = 10;
  const CONN_REFUSED_INTERVAL = 100;
  const BLOCKED_DURATION = 1000;

  const connRefusedMap = new Map();
  const blockedServers = new Map();

  /**
   * MSRP Session
   * @class
   * @property {String} sid Session ID
   * @property {Object} localSdp SDP object contanining the local SDP
   * @property {Object} remoteSdp SDP object contanining the remote SDP
   * @property {Object} localEndpoint URI object describing the local endpoint
   * @property {Array<String>} remoteEndpoints Array of remote endpoints
   * @property {String} remoteConnectionMode The connection mode for the remote endpoint.
   * @property {String} connectionSetup The local connection setup.
   * @property {Object} socket Session socket
   * @property {Boolean} ended Flag that indicating if Session is ended
   * @property {Boolean} setHasNotRan Flag indicating if setDescription has already been called during the SDP negotiation
   * @property {Boolean} getHasNotRan Flag indicating if getDescription has already been called during the SDP negotiation
   */
  class Session extends EventEmitter {
    /**
     * Create a new Session instance.
     *
     * @param {object} [sessionData] Previously exported Session data in case the session is being recreated.
     */
    constructor(sessionData = null) {
      super();

      if (sessionData) {
        if (MsrpSdk.SessionController.hasSession(sessionData.sid)) {
          throw new Error(`A session with sid ${sessionData.sid} already exists`);
        }
        this.sid = sessionData.sid;
        this.localSdp = new MsrpSdk.Sdp(sessionData.localSdp);
        this.localEndpoint = new MsrpSdk.URI(sessionData.localEndpoint);
        this.remoteEndpoints = sessionData.remoteEndpoints;
        this.remoteConnectionMode = sessionData.remoteConnectionMode;
        this.connectionSetup = sessionData.connectionSetup;
        this.acceptTypes = sessionData.acceptTypes;
      } else {
        this.sid = MsrpSdk.Util.newSID();
        this.localSdp = null;
        this.localEndpoint = null;
        this.remoteEndpoints = [];
        this.remoteConnectionMode = 'inactive';
        this.connectionSetup = null;
        this.acceptTypes = [];
      }
      this.remoteSdp = null;
      this.socket = null; // The main socket for this session
      this.ended = false;
      this.heartbeatsEnabled = false;
      this.sendHeartbeatTimeout = null;
      this.heartbeatTimeout = null;
      this.setHasNotRan = true;
      this.getHasNotRan = true;

      // If there is a socket in use, but a new socket is connected/used for this session, it is added to the following array
      // so it can be used as soon as the current socket is closed.
      this.pendingSockets = [];

      MsrpSdk.SessionController.addSession(this);
    }

    _getMediaDescriptions(localMsrpMedia) {
      // Return the corresponding media lines for the saved remote description
      if (!this.remoteSdp) {
        localMsrpMedia.setAttribute('setup', MsrpSdk.Config.setup);
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

    _clearHeartbeatTimeouts() {
      if (this.sendHeartbeatTimeout) {
        clearInterval(this.sendHeartbeatTimeout);
        this.sendHeartbeatTimeout = null;
      }
      if (this.heartbeatTimeout) {
        clearInterval(this.heartbeatTimeout);
        this.heartbeatTimeout = null;
      }
    }

    _raiseHeartbeatFailure(statusCode) {
      try {
        MsrpSdk.Logger.warn(`[Session]: Raise "heartbeatFailure" with status ${statusCode} for session ${this.sid}`);
        this.emit('heartbeatFailure', statusCode, this);
      } catch (err) {
        MsrpSdk.Logger.error('[Session]: Error raising "heartbeatFailure" event.', err);
      }
    }

    _needsReconnection(endpoints) {
      return this.remoteEndpoints.length > 0 && (endpoints.length !== this.remoteEndpoints.length ||
        endpoints.some((ep, idx) => ep !== this.remoteEndpoints[idx]));
    }

    _handleConnRefusedError(remoteServer) {
      const now = Date.now();
      let serverErrors = connRefusedMap.get(remoteServer);
      if (!serverErrors || serverErrors.endInterval < now) {
        serverErrors = {
          count: 1,
          endInterval: now + CONN_REFUSED_INTERVAL
        };
        connRefusedMap.set(remoteServer, serverErrors);
      } else {
        serverErrors.count++;
        if (serverErrors.count > MAX_CONN_REFUSED_PER_INTERVAL) {
          blockedServers.set(remoteServer, now + BLOCKED_DURATION);
          MsrpSdk.Logger.error(`[Session]: Exceeded number of allowed ECONNREFUSED errors for ${remoteServer}. Block server for a short interval.`);
        }
      }
    }

    _connectSession() {
      return new Promise((resolve, reject) => {
        const remoteEndpointUri = new MsrpSdk.URI(this.remoteEndpoints[0]);
        const remoteServer = `${remoteEndpointUri.authority}:${remoteEndpointUri.port}`;

        const blockedUntil = blockedServers.get(remoteServer);
        if (blockedUntil) {
          if (blockedUntil > Date.now()) {
            reject(`Server ${remoteServer} is temporarily blocked`);
            return;
          }
          blockedServers.delete(remoteServer);
        }

        // Do nothing if we are trying to connect to ourselves
        if (this.localEndpoint.address === remoteEndpointUri.address) {
          MsrpSdk.Logger.warn(`[Session]: Not creating a new TCP connection for session ${this.sid} because we would be talking to ourself. Returning...`);
          reject('Cannot create connection to self');
          return;
        }

        const connect = (localPort, finalAttempt) => {
          // Create socket and connect
          const socketInfo = `Local address: ${MsrpSdk.Config.host}:${localPort}, Remote address: ${remoteEndpointUri.address}`;
          MsrpSdk.Logger.info(`[Session]: Creating socket for session ${this.sid}. ${socketInfo}`);

          const rawSocket = new net.Socket();

          const onError = error => {
            MsrpSdk.Logger.error(`[Session]: Error opening socket. ${socketInfo}. ${error}`);
            if (!finalAttempt && error.code === 'EADDRINUSE') {
              MsrpSdk.Logger.info('[Session]: Try allocating a different local port');
              getNextAvailablePort()
                .then(port => connect(port, true))
                .catch(err => {
                  MsrpSdk.Logger.error(`[Session]: Failed to get an available port. ${err}`);
                  reject('Failed to get an available port');
                });
            } else {
              if (error.code === 'ECONNREFUSED') {
                this._handleConnRefusedError(remoteServer);
              }
              reject(error);
            }
          };
          rawSocket.on('error', onError);

          rawSocket.connect({
            host: remoteEndpointUri.authority,
            port: remoteEndpointUri.port,
            localAddress: MsrpSdk.Config.host,
            localPort
          }, () => {
            try {
              MsrpSdk.Logger.info(`[Session]: Connected socket for session ${this.sid}. ${socketInfo}`);
              rawSocket.off('error', onError);
              connRefusedMap.delete(remoteServer);

              const socket = MsrpSdk.SocketHandler(rawSocket);
              socket.startSession(this, resolve);

              // Assign socket to the session
              this.setSocket(socket);
            } catch (error) {
              MsrpSdk.Logger.error(`[Session]: An error ocurred while sending the initial bodiless MSRP message: ${error.toString()}`);
              reject(error);
            }
          });
        };

        if (this.localEndpoint.port !== MsrpSdk.Config.port) {
          // The SDP contained the outbound port. If connections fails then a renegotiation is needed.
          connect(this.localEndpoint.port, true);
        } else {
          MsrpSdk.Logger.info(`[Session]: Get outbound port for session ${this.sid}`);
          getNextAvailablePort()
            .then(port => connect(port, false))
            .catch(err => {
              MsrpSdk.Logger.error(`[Session]: Failed to get an available port. ${err}`);
              reject('Failed to get an available port');
            });
        }
      });
    }

    /**
     * Helper function for establishing connections when the SDP negotiation has been completed.
     */
    _startConnection() {
      // If the SDP negotiation has not been completed, return
      if (this.getHasNotRan || this.setHasNotRan) {
        MsrpSdk.Logger.debug('[Session]: Unable to start connection yet. SDP negotiation in progress.');
        return;
      }

      // Reset SDP negotiation flags
      this.getHasNotRan = true;
      this.setHasNotRan = true;

      // If the session has an active connection, return
      if (this.socket && !this.socket.destroyed) {
        MsrpSdk.Logger.debug(`[Session]: _startConnection - Session ${this.sid} already has an active connection.`);
        return;
      }

      // If inactive attribute is present, do not connect
      if (this.remoteConnectionMode === 'inactive') {
        MsrpSdk.Logger.info('[Session]: Found "a=inactive" in remote endpoint SDP. Connection not needed.');
        return;
      }

      if (!this.remoteEndpoints.length || !this.localEndpoint) {
        MsrpSdk.Logger.info('[Session]: Unable to start connection. Missing remote and/or local enpoint.');
        return;
      }

      if (this.connectionSetup === 'active') {
        this._connectSession()
          .catch(err => {
            MsrpSdk.Logger.error(`[Session]: Failed to connect session. ${err}`);
          });
      }

      this.startHeartbeats();
    }

    /**
     * Check if we can send a message with the given content-type.
     * @param {string} [contentType=text/plain] The message content type.
     * @param {boolean} [logReason=false] Log a warning message in case message cannot be sent.
     */
    canSend(contentType = 'text/plain', logReason = false) {
      if (!this.remoteEndpoints.length) {
        logReason && MsrpSdk.Logger.warn('[Session]: Cannot send message because there is no remote endpoint');
        return false;
      }
      if (!this.socket || this.socket.destroyed) {
        logReason && MsrpSdk.Logger.warn('[Session]: Cannot send message because there is no active socket');
        return false;
      }

      if (this.remoteConnectionMode === 'sendonly' || this.remoteConnectionMode === 'inactive') {
        logReason && MsrpSdk.Logger.warn(`[Session]: Cannot send message because remote SDP is ${this.remoteConnectionMode}`);
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
     * Sends the REPORT message for the given messageId.
     *
     * @param {string} messageId The messageId.
     * @param {number} [status] The report status code. Must be a valid MsrpSdk.Status value. Default is MsrpSdk.Status.OK.
     */
    sendReport(messageId, status = MsrpSdk.Status.OK) {
      if (!MsrpSdk.Config.manualReports) {
        return;
      }

      if (!MsrpSdk.StatusComment[status]) {
        throw new Error(`Invalid status code: ${status}`);
      }

      if (!this.socket || this.socket.destroyed) {
        MsrpSdk.Logger.warn('[Session]: Cannot send REPORT because there is no active socket');
        return;
      }

      this.socket.sendReport(messageId, status);
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
          if (this.localEndpoint) {
            msrpMedia.port = this.localEndpoint.port;
            msrpMedia.setAttribute('path', this.localEndpoint.toString());
          }
          if (this.localSdp === localSdp) {
            // Add new media description for MSRP at the end
            msrpMedia.setAttribute('setup', this.connectionSetup);
            this.localSdp.media.push(msrpMedia);
          }
        }

        // If this is an SDP Answer OR is the first SDP Offer then set the local media descriptions
        if (!this.setHasNotRan || !localSdp.media.length) {
          localSdp.media = this._getMediaDescriptions(msrpMedia);
        }

        this.getHasNotRan = false;
        this.localSdp = localSdp;
        this.connectionSetup = msrpMedia.getAttributeValue('setup');

        if (this.socket && !this.socket.destroyed) {
          MsrpSdk.Logger.debug('[Session]: Session already has an active connection. Just resolve new local description.');
          resolve(localSdp.toString());
          return;
        }

        // Get the assigned local port for configuring the path and the port
        getAssignedPort(this.connectionSetup)
          .then(assignedPort => {
            // Path
            const path = `msrp://${MsrpSdk.Config.signalingHost}:${assignedPort}/${this.sid};tcp`;
            msrpMedia.setAttribute('path', path);
            // Port
            msrpMedia.port = assignedPort;

            // Success! Send local SDP
            resolve(localSdp.toString());

            // Update session information
            this.localEndpoint = new MsrpSdk.URI(path);

            // Start connection if needed
            this._startConnection();
          })
          .catch(error => {
            MsrpSdk.Logger.error(`[Session]: An error ocurred while creating the local SDP. ${error}`);
            this.getHasNotRan = true;
            reject(`${error}`);
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
          MsrpSdk.Logger.warn('[Session]: Remote description does not have MSRP');
          this.setHasNotRan = false;
          this.remoteSdp = remoteSdp;
          this.remoteEndpoints = [];
          this.remoteConnectionMode = 'inactive';
          this.closeSocket(true);
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

        // Update session information
        this.remoteSdp = remoteSdp;
        this.remoteConnectionMode = this.remoteSdp.getMsrpConnectionMode();
        if (this.remoteConnectionMode === 'inactive') {
          MsrpSdk.Logger.info('[Session]: Remote party connection mode is inactive');
          this.remoteEndpoints = [];
          this.closeSocket(true);
        } else {
          const remoteEndpoints = path.split(/\s+/);
          if (this._needsReconnection(remoteEndpoints)) {
            this.closeSocket(true);
          }
          this.remoteEndpoints = remoteEndpoints;

          const acceptTypes = msrpMedia.getAttributeValue('accept-types');
          this.acceptTypes = acceptTypes ? acceptTypes.split(/\s+/) : [];

          // Start connection if needed
          this._startConnection();
        }

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
        this.stopHeartbeats();

        // Empty pending sockets and close connected socket (if applicable)
        this.closeSocket(true);

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
     * @param {boolean} suppressSocketSet Set to true to suppress emitting the 'socketSet' event.
     */
    setSocket(socket, suppressSocketSet = false) {
      if (this.socket) {
        // This coud be a replacement socket. Add to pending list.
        MsrpSdk.Logger.info(`[Session]: Add pending socket for session ${this.sid}. ${socket.socketInfo}`);
        this.pendingSockets.push(socket);
        if (this.socket.destroyed) {
          this.closeSocket(false);
        }
        return;
      }

      MsrpSdk.Logger.info(`[Session]: Set socket for session ${this.sid}. ${socket.socketInfo}`);

      this.socket = socket;
      socket.sessions.add(this.sid);

      // TODO: Add origin check. Ticket: https://github.com/cwysong85/msrp-node-lib/issues/20

      // Forward socket events
      this._onSocketClose = hadError => {
        MsrpSdk.Logger.info(`[Session]: Received socket close event for session ${this.sid}`);
        // Invoke closeSocket to unregister the socket event handlers and to set any pending socket.
        // If there is no pending socket then this.socket will be set to null.
        this.closeSocket(false);
        if (!this.socket) {
          this.emit('socketClose', hadError, this);
        }
      };

      this._onSocketError = () => {
        MsrpSdk.Logger.info(`[Session]: Received socket error event for session ${this.sid}`);
        this.emit('socketError', this);
      };

      this._onSocketTimeout = () => {
        MsrpSdk.Logger.info(`[Session]: Received socket timeout event for session ${this.sid}`);
        this.emit('socketTimeout', this);
      };

      socket.on('close', this._onSocketClose);
      socket.on('error', this._onSocketError);
      socket.on('timeout', this._onSocketTimeout);

      if (!suppressSocketSet) {
        // Emit socketSet event
        this.emit('socketSet', this);
      }
    }

    /**
     * Closes a session socket
     *
     * @param {boolean} clearPending - Also clear any pending sockets.
     */
    closeSocket(clearPending) {
      if (clearPending && this.pendingSockets.length > 0) {
        this.pendingSockets = [];
      }
      if (!this.socket) {
        return;
      }
      this.socket.sessions.delete(this.sid);

      // Unregister from socket events
      this.socket.removeListener('close', this._onSocketClose);
      this.socket.removeListener('error', this._onSocketError);
      this.socket.removeListener('timeout', this._onSocketTimeout);

      if (!this.socket.destroyed) {
        // Check if the session socket is being reused by other session
        const isSocketReused = this.socket.sessions.size > 0;
        // Close the socket if it is not being reused by other session
        if (isSocketReused) {
          MsrpSdk.Logger.info(`[Session]: Socket for session ${this.sid} is being reused. Do not close it.`);
        } else {
          MsrpSdk.Logger.info('[Session]: Closing socket for session', this.sid);
          this.socket.destroy();
        }
      }

      // Clean the session socket attribute
      MsrpSdk.Logger.info(`[Session]: Removed socket for session ${this.sid}. ${this.socket.socketInfo}`);
      this.socket = null;

      // Check if there is a pending socket
      while (this.pendingSockets.length > 0) {
        const nextSocket = this.pendingSockets.shift();
        if (!nextSocket.destroyed) {
          this.setSocket(nextSocket, true);
          break;
        }
      }
    }

    /**
     * Send a heartbeat message for this session.
     */
    sendHeartbeat() {
      this._clearHeartbeatTimeouts();
      if (!this.heartbeatsEnabled) {
        return;
      }

      if (this.socket && !this.canSend('text/x-msrp-heartbeat')) {
        MsrpSdk.Logger.warn(`[Session]: Cannot start heartbeats for session ${this.sid}. Peer does not support 'text/x-msrp-heartbeat' content.`);
        return;
      }

      let timedOut = false;

      const msgQueued = this.sendMessage('HEARTBEAT', 'text/x-msrp-heartbeat', null, status => {
        if (timedOut) {
          return;
        }
        this._clearHeartbeatTimeouts();
        if (status === MsrpSdk.Status.OK) {
          MsrpSdk.Logger.debug('Successful heartbeat for session', this.sid);
        } else {
          this._raiseHeartbeatFailure(status);
        }
        this.resetHeartbeat();
      });

      if (!msgQueued) {
        this._raiseHeartbeatFailure(MsrpSdk.Status.INTERNAL_SERVER_ERROR);
        this.resetHeartbeat();
        return;
      }

      this.heartbeatTimeout = setTimeout(() => {
        timedOut = true;
        this.heartbeatTimeout = null;
        this._raiseHeartbeatFailure(MsrpSdk.Status.REQUEST_TIMEOUT);
        this.resetHeartbeat();
      }, MsrpSdk.Config.heartbeatTimeout * 1000);
    }

    /**
     * Restart the hearbeat interval.
     */
    resetHeartbeat(immediate) {
      if (!this.heartbeatsEnabled || this.heartbeatTimeout) {
        // Either heartbeat is not enabled OR we are waiting for a heartbeat response.
        return;
      }
      this._clearHeartbeatTimeouts();
      MsrpSdk.Logger.debug('Reset heartbeat timer for session', this.sid);
      this.sendHeartbeatTimeout = setTimeout(() => {
        this.sendHeartbeatTimeout = null;
        this.sendHeartbeat();
      }, immediate ? 0 : MsrpSdk.Config.heartbeatInterval * 1000);
    }

    /**
     * Stops MSRP heartbeats
     */
    stopHeartbeats() {
      this._clearHeartbeatTimeouts();
      if (this.heartbeatsEnabled) {
        MsrpSdk.Logger.debug('[Session]: Stopping MSRP heartbeats for session', this.sid);
        this.heartbeatsEnabled = false;
      }
    }

    /**
     * Starts MSRP heartbeats
     */
    startHeartbeats(immediate) {
      if (MsrpSdk.Config.enableHeartbeats) {
        MsrpSdk.Logger.debug('[Session]: Starting MSRP heartbeats for session', this.sid);
        this.heartbeatsEnabled = true;
        this.resetHeartbeat(immediate);
      }
    }

    /**
     * Helper function for re-establishing connection of an active call.
     * @returns {Promise} Promise resolved when connection is succesfull.
     */
    startReconnection() {
      // If the session has an active connection, return
      if (this.socket && !this.socket.destroyed) {
        MsrpSdk.Logger.debug('[Session]: startReconnection - Session already has an active connection.');
        return Promise.resolve();
      }

      // If the SDP negotiation has not been completed, return
      if (!this.remoteEndpoints.length || !this.localEndpoint) {
        return Promise.reject('Unable to start connection. Missing remote and/or local endpoint');
      }

      MsrpSdk.Logger.info(`[Session]: Start socket reconnection for session ${this.sid}`);
      this.stopHeartbeats();
      return this._connectSession()
        .then(() => {
          this.startHeartbeats(true);
        });
    }

    /**
     * Exports the MSRP session data which can be used to reconstruct the Session.
     *
     * @returns {object} - The MSRP session data if SDP negotiation is complete and endpoints are set. Otherwise null.
     */
    exportSessionData() {
      if (!this.getHasNotRan || !this.setHasNotRan || !this.localEndpoint || !this.remoteEndpoints.length) {
        return null;
      }
      return {
        acceptTypes: this.acceptTypes,
        connectionSetup: this.connectionSetup,
        localEndpoint: this.localEndpoint.toString(),
        localSdp: this.localSdp.toString(),
        remoteConnectionMode: this.remoteConnectionMode,
        remoteEndpoints: this.remoteEndpoints,
        sid: this.sid
      };
    }

  }

  /////////////////////////////////////////////////////////////////////////////////////////////////
  // Port finder helper functions
  /////////////////////////////////////////////////////////////////////////////////////////////////
  const portfinder = require('portfinder');
  const { outboundBasePort, outboundHighestPort } = MsrpSdk.Config;

  portfinder.basePort = outboundBasePort;
  // @ts-ignore
  portfinder.highestPort = outboundHighestPort;

  // Start at a random port between the range
  let nextBasePort = outboundBasePort + Math.floor(Math.random() * (outboundHighestPort - outboundBasePort));

  // Porfinder doesn't behave properly in some operating systems in case it receives requests in parallel.
  let pendingPortRequest = false;
  const queuedPortRequests = [];

  /**
   * Helper function for getting the assigned port for the session description.
   *
   * @param {string} setup Local setup line content.
   * @return {Promise<number>} Local port to be used in the session; or null if config port should be used.
   */
  function getAssignedPort(setup) {
    if (MsrpSdk.Config.offerInboundPortOnSdp || setup !== 'active') {
      return Promise.resolve(MsrpSdk.Config.port);
    }
    return getNextAvailablePort();
  }

  /**
   * Helper function for getting the next available port in the allowed port range. This function queues the requests to ensure
   * only one request is processed at a time.
   *
   * @return {Promise<number>} Next available port.
   */
  function getNextAvailablePort() {
    return new Promise((resolve, reject) => {
      queuedPortRequests.push({ resolve, reject });
      if (!pendingPortRequest) {
        processNextRequest();
      }
    });
  }

  /**
   * Processes the next port finder request in the queue.
   */
  function processNextRequest() {
    if (pendingPortRequest || !queuedPortRequests.length) {
      return;
    }
    pendingPortRequest = true;
    const { resolve, reject } = queuedPortRequests.shift();
    getPortPromise(false)
      .then(resolve)
      .catch(reject)
      .finally(() => {
        pendingPortRequest = false;
        processNextRequest();
      });
  }

  /**
   * Helper function for getting the next available port in the allowed port range.
   *
   * @param {boolean} finalAttempt - Indicates whether this should be the final attempt.
   * @return {Promise<number>} Next available port.
   */
  function getPortPromise(finalAttempt = false) {
    if (nextBasePort > outboundHighestPort) {
      nextBasePort = outboundBasePort;
    }
    const port = nextBasePort;
    return portfinder.getPortPromise({
      port,
      stopPort: outboundHighestPort
    })
      .then(assignedPort => {
        MsrpSdk.Logger.info(`[Session]: Assigned outbound port for MSRP connection: ${assignedPort}`);
        nextBasePort = Math.max(assignedPort + 1, nextBasePort);
        return assignedPort;
      })
      .catch(err => {
        if (!finalAttempt && port > outboundBasePort) {
          // Retry again from the beginning
          nextBasePort = outboundBasePort;
          return getPortPromise(true);
        } else {
          return Promise.reject(err);
        }
      });
  }

  MsrpSdk.Session = Session;
};
