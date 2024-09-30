// Dependencies
const net = require('net');
const util = require('util');
const portfinder = require('portfinder');
const EventEmitter = require('events').EventEmitter;

module.exports = function(MsrpSdk) {
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
   * @property {Function} socketConnectTimeoutFunc Timeout function for socket connection
   * @property {String} sdpState SDP negotiation state (offered, answered)
   */
  const Session = function() {
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
    this.socketConnectTimeoutFunc = null;
    this.sdpState = null;
  };

  util.inherits(Session, EventEmitter); // NOTE: Sessions emit events in SocketHandler too

  /**
   * Sends an MSRP Message to the Session's remote party
   * @param  {String}   body        Message body
   * @param  {Function} callback    Callback function
   * @param  {String}   contentType Message Content-Type
   */
  Session.prototype.sendMessage = function(body, callback, contentType = 'text/plain', requestReports) {
    const session = this;

    // Check if the remote endpoint will accept the message by checking its SDP
    // accept-types
    const contentValues = contentType.split('/');
    let canSend = session.remoteSdp.attributes['accept-types'].some(function(acceptType) {
      if (acceptType === contentType || acceptType === '*') {
        return true;
      }
      const acceptValues = acceptType.split('/');
      return (acceptValues[0] === contentValues[0] && acceptValues[1] === '*');
    });
    // sendonly/inactive 
    if (session.remoteSdp.attributes.sendonly || session.remoteSdp.attributes.inactive) {
      canSend = false;
    }
    if (session.remoteSdp.media?.[0]?.attributes) {
      if (session.remoteSdp.media[0].attributes.sendonly || session.remoteSdp.media[0].attributes.inactive) {
        canSend = false;
      }
    }

    if (canSend) {
      if (session.socket) {
        session.socket.sendMessage(session, {
          body: body,
          contentType: contentType
        }, {
          toPath: session.remoteEndpoints,
          localUri: session.localEndpoint.uri
        }, callback, requestReports);
      } else {
        // We don't have a socket. Did the other side send a connection?
        MsrpSdk.Logger.error('[MSRP Session] Cannot send message because there is not an active socket! Did the remote side connect? Check a=setup line in SDP media.');
        if (callback) {
          callback(null, new Error('Socket unavailable'));
        }
        return;
      }
    } else {
      MsrpSdk.Logger.warn('[MSRP Session] Cannot send message due to remote endpoint SDP attributes');
      if (callback) {
        callback(null, new Error('Cannot send message due to remote endpoint SDP attributes'));
      }
      return;
    }
  };

  /**
   * Function called during the SDP negotiation to create the local SDP.
   * @param  {Function} onSuccess onSuccess callback
   * @param  {Function} onFailure onFailure callback
   * @param  {Object}   mediaHint mediaHint options
   */
  Session.prototype.getDescription = async function(onSuccess, onFailure, mediaHint) {
    try {
      const session = this;
      MsrpSdk.Logger.debug('[MSRP Session] Creating local SDP...');

      // Create local SDP
      const localSdp = new MsrpSdk.Sdp.Session();
      // Origin
      localSdp.origin.id = MsrpSdk.Util.dateToNtpTime(new Date());
      localSdp.origin.version = localSdp.origin.id;
      localSdp.origin.address = MsrpSdk.Config.host;
      // Session-name
      localSdp.sessionName = MsrpSdk.Config.sessionName;
      // Connection address
      localSdp.connection.address = MsrpSdk.Config.host;
      // Accept-types
      localSdp.addAttribute('accept-types', mediaHint?.acceptTypes ?? MsrpSdk.Config.acceptTypes);
      // Setup
      if (MsrpSdk.Config.forceSetup) {
        localSdp.addAttribute('setup', MsrpSdk.Config.setup);
      } else if (session.remoteSdp) {
        if (session.remoteSdp.attributes.setup) {
          if (session.remoteSdp.attributes.setup[0] === 'active' || session.remoteSdp.attributes.setup[0] === 'actpass') {
            localSdp.addAttribute('setup', 'passive');
          } else if (session.remoteSdp.attributes.setup[0] === 'passive') {
            localSdp.addAttribute('setup', 'active');
          } else {
            MsrpSdk.Logger.error('[MSRP Session] Invalid remote a=setup value');
            return onFailure('Invalid remote a=setup value');
          }
        } else {
          localSdp.addAttribute('setup', 'passive');
        }
      } else {
        localSdp.addAttribute('setup', MsrpSdk.Config.setup === 'passive' ? 'passive' : 'active');
      }
      // Path
      const assignedPort = await getAssignedPort(localSdp.attributes.setup[0], session.localEndpoint?.port);
      const path = `msrp://${MsrpSdk.Config.host}:${assignedPort}/${session.sid};tcp`;
      localSdp.addAttribute('path', path);
      // Media
      localSdp.media.push(`message ${assignedPort} TCP/MSRP *`);

      // If we are updating an existing session, close existing socket when needed
      if (session.localSdp) {
        if (session.socket) {
          if (localSdp.attributes.path !== session.localSdp.attributes.path) {
            MsrpSdk.Logger.debug(`[MSRP Session] Local path updated: ${session.localSdp.attributes.path} -> ${localSdp.attributes.path}`);
            session.closeSocket();
          }
          if (localSdp.attributes.inactive) {
            MsrpSdk.Logger.debug('[MSRP Session] Local party connection changed to inactive');
            session.closeSocket();
          }
        }
      }

      // Update session
      session.localSdp = localSdp;
      session.localEndpoint = new MsrpSdk.URI(path);

      // Success! Send local SDP and update SDP negotiation state
      onSuccess(localSdp.toString());
      session.updateSdpState();

      // If the SDP negotiation is complete, proceed to connection setup
      if (session.sdpState === 'answered') {
        session.setupConnection();
      }
    } catch (error) {
      MsrpSdk.Logger.error(`[MSRP Session] An error ocurred while creating the local SDP: ${error.toString()}`);
      return;
    }
  };

  /**
   * Function called during the SDP negotiation to set the remote SDP.
   * @param  {String}   description Remote description
   * @param  {Function} onSuccess   onSuccess callback
   * @param  {Function} onFailure   onFailure callback
   */
  Session.prototype.setDescription = function(description, onSuccess, onFailure) {
    try {
      const session = this;
      MsrpSdk.Logger.debug('[MSRP Session] Processing remote SDP...');

      // Parse remote SDP
      const remoteSdp = new MsrpSdk.Sdp.Session(description);
      // Retrieve MSRP media attributes
      const remoteMsrpMedia = remoteSdp.media.find(function(mediaObject) {
        return mediaObject.proto.includes('/MSRP');
      });
      remoteSdp.attributes = remoteMsrpMedia.attributes;
      // Path check
      if (!remoteSdp.attributes.path) {
        MsrpSdk.Logger.error('[MSRP Session] Path attribute missing in remote endpoint SDP');
        return onFailure('Path attribute missing in remote endpoint SDP');
      }

      // If we are updating an existing session, close existing socket when needed
      if (session.remoteSdp) {
        if (session.socket) {
          if (remoteSdp.attributes.path !== session.remoteSdp.attributes.path) {
            MsrpSdk.Logger.debug(`[MSRP Session] Remote path updated: ${session.remoteSdp.attributes.path.join(' ')} -> ${remoteSdp.attributes.path.join(' ')}`);
            session.closeSocket();
          }
          if (remoteSdp.attributes.inactive) {
            MsrpSdk.Logger.debug('[MSRP Session] Remote party connection changed to inactive');
            session.closeSocket();
          }
        }
      }

      // Update session information
      session.remoteSdp = remoteSdp;
      session.remoteEndpoints = remoteSdp.attributes.path;

      // Success! Remote SDP processed. Update SDP negotiation state.
      onSuccess();
      session.updateSdpState();

      // If the SDP negotiation is complete, proceed to connection setup
      if (session.sdpState === 'answered') {
        session.setupConnection();
      }
    } catch (error) {
      MsrpSdk.Logger.error(`[MSRP Session] An error ocurred while processing the remote SDP: ${error.toString()}`);
      return;
    }
  };

  /**
   * Ends a session
   * NOTE: Most of the time this function should not be called directly. Use SessionController.removeSession instead.
   */
  Session.prototype.end = function() {
    const session = this;

    // Return if session is already ended
    if (session.ended) {
      MsrpSdk.Logger.debug(`[MSRP Session] MSRP session ${session.sid} already ended`);
      return;
    }

    MsrpSdk.Logger.debug(`[MSRP Session] Ending MSRP session ${session.sid}...`);
    // Stop heartbeats if needed
    if (MsrpSdk.Config.enableHeartbeats !== false) {
      session.stopHeartbeats();
    }
    // Close socket if needed
    if (session.socket) {
      session.closeSocket();
    }
    // Set ended flag to true
    session.ended = true;
    // Emit 'end' event
    session.emit('end', session);
  };

  /**
   * Sets the session's socket and the needed socket event listeners
   * @param  {Object}   socket    Socket
   * @param  {Boolean}  sdpCheck  Enable SDP check
   */
  Session.prototype.setSocket = function(socket, sdpCheck = true) {
    const session = this;

    // If sdpCheck is enabled, do not set socket if it is not coming from the expected address
    if (sdpCheck) {
      const remoteSocketAddress = `${socket.remoteAddress}:${socket.remotePort}`;
      const remoteEndpointUri = new MsrpSdk.URI(session.remoteEndpoints[0]);
      const expectedSocketAddress = `${remoteEndpointUri.authority}:${remoteEndpointUri.port}`;
      if (remoteSocketAddress !== expectedSocketAddress) {
        throw new Error(`Socket does not belong to the expected remote endpoint. Got ${remoteSocketAddress}, expected ${expectedSocketAddress}.`);
      }
    }

    // Clear socket connect timeout function
    clearTimeout(session.socketConnectTimeoutFunc);

    // Set socket
    session.socket = socket;

    // Forward socket events
    socket.on('close', function(hadError) {
      session.emit('socketClose', hadError, session);
      // Socket Reconnect Timeout logic
      if (!session.ended && MsrpSdk.Config.socketReconnectTimeout > 0) {
        setTimeout(function() {
          if (!session.ended && session.socket?.destroyed) {
            session.emit('socketReconnectTimeout', session);
          }
        }, MsrpSdk.Config.socketReconnectTimeout);
      }
    });
    socket.on('error', function() {
      session.emit('socketError', session);
    });
    socket.on('timeout', function() {
      session.emit('idleSocketTimeout', session);
    });

    // Emit socketSet event
    session.emit('socketSet', session);
  };

  /**
   * Closes a session socket
   */
  Session.prototype.closeSocket = function() {
    const session = this;
    if (session.socket) {
      // Check if the session socket is being reused by other session
      const isSocketReused = MsrpSdk.SessionController.sessions.filter(function(sessionItem) {
        return sessionItem.socket === session.socket;
      }).length > 1;

      // Close the socket if it is not being reused by other session
      if (!isSocketReused) {
        MsrpSdk.Logger.debug(`[MSRP Session] Closing MSRP session ${session.sid} socket...`);
        session.socket.end();
      }

      // Clean the session socket attribute
      MsrpSdk.Logger.debug(`[MSRP Session] Removing MSRP session ${session.sid} socket...`);
      delete session.socket;
    }
  };

  /**
   * Stops MSRP heartbeats
   */
  Session.prototype.stopHeartbeats = function() {
    const session = this;
    MsrpSdk.Logger.debug(`[MSRP Session] Stopping MSRP heartbeats for session ${session.sid}...`);
    clearInterval(session.heartbeatPingFunc);
    clearInterval(session.heartbeatTimeoutFunc);
    session.heartbeatPingFunc = null;
    session.heartbeatTimeoutFunc = null;
  };

  /**
   * Starts MSRP heartbeats
   */
  Session.prototype.startHeartbeats = function() {
    const session = this;
    const heartbeatsInterval = MsrpSdk.Config.heartbeatsInterval || 5000;
    const heartbeatsTimeout = MsrpSdk.Config.heartbeatsTimeout || 10000;

    MsrpSdk.Logger.debug(`[MSRP Session] Starting MSRP heartbeats for session ${session.sid}...`);

    // Send heartbeats
    function sendHeartbeat() {
      session.sendMessage('HEARTBEAT', null, 'text/x-msrp-heartbeat');
    }
    session.heartbeatPingFunc = setInterval(sendHeartbeat, heartbeatsInterval);

    // Look for timeouts every second
    function heartbeatTimeoutMonitor() {
      for (const key in session.heartbeatsTransIds) { // Loop through all stored heartbeats
        if (session.heartbeatsTransIds.hasOwnProperty(key)) { // Check if key has a property
          const diff = Date.now() - session.heartbeatsTransIds[key]; // Get time difference
          if (diff > heartbeatsTimeout) { // If the difference is greater than heartbeatsTimeout
            MsrpSdk.Logger.error(`[MSRP Session] MSRP heartbeat timeout for session ${session.sid}`);
            session.emit('heartbeatTimeout', session);
            delete session.heartbeatsTransIds[key];
          }
        }
      }
    }
    session.heartbeatTimeoutFunc = setInterval(heartbeatTimeoutMonitor, 1000);
  };

  /**
   * Helper function for connection setup once the SDP negotiation has been completed
   */
  Session.prototype.setupConnection = function() {
    const session = this;

    // If the SDP negotiation has not been completed, return
    if (session.sdpState !== 'answered') {
      MsrpSdk.Logger.debug('[MSRP Session] Unable to start connection yet. SDP negotiation in progress.');
      return;
    }

    // If inactive attribute is present, do not connect
    if (session.remoteSdp.attributes.inactive) {
      MsrpSdk.Logger.warn('[MSRP Session] Found "a=inactive" in remote endpoint SDP. Connection not needed.');
      return;
    }

    // Get remote and local endpoint URIs
    const remoteEndpointUri = new MsrpSdk.URI(session.remoteEndpoints[0]);
    const localEndpointUri = session.localEndpoint;

    // If the local endpoint is active, connect to the remote party
    if (session.localSdp.attributes.setup[0] === 'active') {
      // Create socket and connect
      MsrpSdk.Logger.debug(`[MSRP Session] MSRP session ${session.sid} local endpoint is active. Creating socket...`);
      const socket = new MsrpSdk.SocketHandler(new net.Socket());
      socket.connect({
        host: remoteEndpointUri.authority,
        port: remoteEndpointUri.port,
        localAddress: localEndpointUri.authority,
        localPort: parseInt(localEndpointUri.port)
      }, () => {
        try {
          // Assign socket to the session
          session.setSocket(socket);
          // Send bodiless MSRP message
          const request = new MsrpSdk.Message.OutgoingRequest({
            toPath: session.remoteEndpoints,
            localUri: session.localEndpoint.uri
          }, 'SEND');
          request.addHeader('message-id', MsrpSdk.Util.newMID());
          const encodedRequest = request.encode();
          socket.write(encodedRequest, () => {
            // Emit 'messageSent' event.
            session.emit('messageSent', request, session, encodedRequest);
          });
        } catch (error) {
          MsrpSdk.Logger.error(`[MSRP Session] Error during MSRP session ${session.sid} socket initialization: ${error.toString()}`);
        }
      });
    } else {
      // Check if there is a dangling socket waiting to be assigned to this session
      const socketIndex = MsrpSdk.Server.danglingSockets.findIndex(function(danglingSocket) {
        return danglingSocket.remoteAddress === remoteEndpointUri.authority && danglingSocket.remotePort == remoteEndpointUri.port;
      });
      if (socketIndex !== -1) {
        try {
          // If there is a socket, assign it to the session and remove it from the dangling sockets list
          MsrpSdk.Logger.debug(`[MSRP Session] Found dangling socket for MSRP Session ID ${session.sid}. Setting socket...`);
          const socket = MsrpSdk.Server.danglingSockets[socketIndex];
          MsrpSdk.Server.danglingSockets.splice(socketIndex, 1);
          session.setSocket(socket);
        } catch (error) {
          MsrpSdk.Logger.error(`[MSRP Session] Error setting socket for session ${session.sid}: ${error}`);
        }
      } else {
        // If there is no socket, wait for the remote party to connect
        MsrpSdk.Logger.debug(`[MSRP Session] No dangling socket found for session ${session.sid}. Waiting for remote party to connect...`);

        // If the socket is not connected after a certain time, end the session
        if (MsrpSdk.Config.socketConnectTimeout > 0) {
          // Clear any existing socket connect timeout function (e.g. re-invites)
          clearTimeout(session.socketConnectTimeoutFunc);
          // Set socket connect timeout function
          session.socketConnectTimeoutFunc = setTimeout(() => {
            if (!session.socket && !session.ended && !session.remoteSdp.attributes.inactive && !session.localSdp.attributes.inactive) {
              MsrpSdk.Logger.warning(`[MSRP Session] Socket connect timeout. No socket connected to session ${session.sid}. Ending session...`);
              session.emit('socketConnectTimeout', session);
            }
          }, MsrpSdk.Config.socketConnectTimeout);
        }
      }
    }

    // Emit 'update' event if the session has been updated
    if (session.updated) {
      session.emit('update', session);
    }

    // Start heartbeats if enabled and not running yet
    const canHeartbeat = session.remoteSdp.attributes['accept-types'].some(function(acceptType) {
      return acceptType === 'text/x-msrp-heartbeat' || acceptType === 'text/*' || acceptType === '*';
    });
    if (canHeartbeat && MsrpSdk.Config.enableHeartbeats !== false && !session.heartbeatPingFunc && !session.heartbeatTimeoutFunc) {
      session.startHeartbeats();
    }
  };

  /**
   * Helper function for updating SDP negotiation state
   */
  Session.prototype.updateSdpState = function() {
    const session = this;
    switch (session.sdpState) {
      case null:
        session.sdpState = 'offered';
        break;
      case 'offered':
        session.sdpState = 'answered';
        break;
      case 'answered':
        session.sdpState = 'offered';
        session.updated = true;
        break;
    }
    MsrpSdk.Logger.debug(`[MSRP Session] SDP negotiation state updated to ${session.sdpState} for session ${session.sid}`);
  };

  /**
   * Helper function for getting the local port to be used
   * @param  {String}           setup       Local setup line content
   * @param  {Number}           currentPort Current local port
   * @return {Promise<Number>}              Local port to be used
   */
  function getAssignedPort(setup, currentPort) {
    return new Promise((resolve, reject) => {
      if (setup === 'active') {
        if (currentPort && currentPort != MsrpSdk.Config.port && MsrpSdk.Config.reuseOutboundPortOnReInvites !== false) {
          return resolve(currentPort);
        } else {
          const configuredBasePort = MsrpSdk.Config.outboundBasePort ?? 49152;
          const configuredHighestPort = MsrpSdk.Config.outboundHighestPort ?? 65535;
          const randomBasePort = Math.ceil(Math.random() * (configuredHighestPort - configuredBasePort)) + configuredBasePort;
          return resolve(portfinder.getPortPromise({
            port: randomBasePort,
            stopPort: configuredHighestPort
          }));
        }
      } else {
        return resolve(MsrpSdk.Config.port);
      }
    });
  }

  MsrpSdk.Session = Session;
};
