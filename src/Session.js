// Dependencies
var net = require('net');
var util = require('util');
var portfinder = require('portfinder');
var EventEmitter = require('events').EventEmitter;

module.exports = function(MsrpSdk) {
  // Load configuration
  var configuredBasePort = MsrpSdk.Config.outboundBasePort || 49152;
  var configuredHighestPort = MsrpSdk.Config.outboundHighestPort || 65535;

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
   * @property {Boolean} reinvite (Deprecated) Flag that indicates if a re-INVITE has just been received // TODO: Deprecated
   * @property {Object} heartbeatsTransIds Dictionary of heartbeats transaction IDs
   * @property {Function} heartbeatPingFunc Ping function for heartbeats
   * @property {Function} heartbeatTimeoutFunc Timeout function for heartbeats
   * @property {Boolean} setHasNotRan Flag indicating if setDescription has already been called during the SDP negotiation
   * @property {Boolean} getHasNotRan Flag indicating if getDescription has already been called during the SDP negotiation
   */
  var Session = function() {
    this.sid = MsrpSdk.Util.newSID();
    this.localEndpoint = null;
    this.remoteEndpoints = [];
    this.localSdp = null;
    this.remoteSdp = null;
    this.socket = null;
    this.updated = false;
    this.ended = false;
    this.reinvite = false; // TODO: Deprecated
    this.heartbeatsTransIds = {};
    this.heartbeatPingFunc = null;
    this.heartbeatTimeoutFunc = null;
    this.setHasNotRan = true;
    this.getHasNotRan = true;
  };

  util.inherits(Session, EventEmitter); // NOTE: Sessions emit events in SocketHandler too

  /**
   * Sends an MSRP Message to the Session's remote party
   * @param  {String}   body        Message body
   * @param  {Function} callback    Callback function
   * @param  {String}   contentType Message Content-Type
   */
  Session.prototype.sendMessage = function(body, callback, contentType) {
    var session = this;

    // Check if the remote endpoint will accept the message by checking its SDP
    contentType = contentType || 'text/plain';
    var canSend = session.remoteSdp.attributes['accept-types'].some(function(acceptType) {
      return (acceptType === contentType || acceptType === '*');
    });
    if (session.remoteSdp.attributes.sendonly || session.remoteSdp.attributes.inactive) {
      canSend = false;
    }

    if (session.remoteSdp.media && session.remoteSdp.media[0] && session.remoteSdp.media[0].attributes) {
      if (session.remoteSdp.media[0].attributes.sendonly) {
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
        }, callback);
      } else {
        // We don't have a socket. Did the other side send a connection?
        MsrpSdk.Logger.error('[MSRP Session] Cannot send message because there is not an active socket! Did the remote side connect? Check a=setup line in SDP media.');
        return;
      }
    } else {
      MsrpSdk.Logger.warn('[MSRP Session] Cannot send message due to remote endpoint SDP attributes');
      return;
    }
  };

  /**
   * Function called during the SDP negotiation to create the local SDP.
   * @param  {Function} onSuccess onSuccess callback
   * @param  {Function} onFailure onFailure callback
   */
  Session.prototype.getDescription = function(onSuccess, onFailure) {
    var session = this;
    MsrpSdk.Logger.debug('[MSRP Session] Creating local SDP...');

    // Create and configure local SDP
    var localSdp = new MsrpSdk.Sdp.Session();
    // Origin
    localSdp.origin.id = MsrpSdk.Util.dateToNtpTime(new Date());
    localSdp.origin.version = localSdp.origin.id;
    localSdp.origin.address = MsrpSdk.Config.host;
    // Session-name
    localSdp.sessionName = MsrpSdk.Config.sessionName;
    // Connection address
    localSdp.connection.address = MsrpSdk.Config.host;
    // Accept-types
    localSdp.addAttribute('accept-types', MsrpSdk.Config.acceptTypes);
    // Setup
    if (session.remoteSdp) {
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
    // Get the assigned local port for configuring the path and the port
    getAssignedPort(localSdp.attributes.setup[0])
      .then(function(assignedPort) {
        // Path
        var path = 'msrp://' + MsrpSdk.Config.host + ':' + assignedPort + '/' + session.sid + ';tcp';
        localSdp.addAttribute('path', path);
        // Port
        localSdp.media.push('message ' + assignedPort + ' TCP/MSRP *');

        // Success! Send local SDP
        onSuccess(localSdp.toString());

        // Update session information
        session.localSdp = localSdp;
        session.localEndpoint = new MsrpSdk.URI(path);
        session.getHasNotRan = false;

        // Extra logic for session updates
        var callback;
        if (session.updated) {
          // Emit update event after calling startConnection
          callback = function() {
            session.emit('update', session);
            session.emit('reinvite', session); // TODO: Deprecated
          };
        }

        // Start connection if needed
        session.startConnection(callback);
      })
      .catch(function(error) {
        MsrpSdk.Logger.error(`[MSRP Session] An error ocurred while creating the local SDP: ${error.toString()}`);
        return;
      });
  };

  /**
   * Function called during the SDP negotiation to set the remote SDP.
   * @param  {String}   description Remote description
   * @param  {Function} onSuccess   onSuccess callback
   * @param  {Function} onFailure   onFailure callback
   */
  Session.prototype.setDescription = function(description, onSuccess, onFailure) {
    var session = this;
    MsrpSdk.Logger.debug('[MSRP Session] Processing remote SDP...');

    // Parse received SDP
    var remoteSdp = new MsrpSdk.Sdp.Session(description);

    // Retrieve MSRP media attributes
    var remoteMsrpMedia = remoteSdp.media.find(function(mediaObject) {
      return mediaObject.proto.includes('/MSRP');
    });
    remoteSdp.attributes = remoteMsrpMedia.attributes;

    // Path check
    if (!remoteSdp.attributes.path) {
      MsrpSdk.Logger.error('[MSRP Session] Path attribute missing in remote endpoint SDP');
      return onFailure('Path attribute missing in remote endpoint SDP');
    }

    // If we are updating an existing session, enable updated flag and close existing socket when needed
    if (session.remoteSdp) {
      session.updated = true;
      session.reinvite = true; // Deprecated
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
    session.setHasNotRan = false;

    // Success! Remote SDP processed
    onSuccess();

    // Start connection if needed
    session.startConnection();
  };

  /**
   * Ends a session
   */
  Session.prototype.end = function() {
    var session = this;

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
   * Sets the session's socket and and the needed socket event listeners
   * @param  {Object} socket Socket
   */
  Session.prototype.setSocket = function(socket) {
    var session = this;
    session.socket = socket;

    // TODO: Add origin check. Ticket: https://github.com/cwysong85/msrp-node-lib/issues/20

    // Forward socket events
    socket.on('close', function(hadError) {
      session.emit('socketClose', hadError, session);
    });
    socket.on('error', function() {
      session.emit('socketError', session);
    });
    socket.on('timeout', function() {
      session.emit('socketTimeout', session);
    });

    // Emit socketConnect event
    session.emit('socketSet', session);
    session.emit('socketConnect', session); // TODO: Deprecated
  };

  /**
   * Closes a session socket
   */
  Session.prototype.closeSocket = function() {
    var session = this;
    if (session.socket) {
      // Check if the session socket is being reused by other session
      var isSocketReused = MsrpSdk.SessionController.sessions.filter(function(sessionItem) {
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
    var session = this;
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
    var session = this;
    var heartbeatsInterval = MsrpSdk.Config.heartbeatsInterval || 5000;
    var heartbeatsTimeout = MsrpSdk.Config.heartbeatsTimeout || 10000;

    MsrpSdk.Logger.debug(`[MSRP Session] Starting MSRP heartbeats for session ${session.sid}...`);

    // Send heartbeats
    function sendHeartbeat() {
      session.sendMessage('HEARTBEAT', null, 'text/x-msrp-heartbeat');
    }
    session.heartbeatPingFunc = setInterval(sendHeartbeat, heartbeatsInterval);

    // Look for timeouts every second
    function heartbeatTimeoutMonitor() {
      for (var key in session.heartbeatsTransIds) { // Loop through all stored heartbeats
        if (session.heartbeatsTransIds.hasOwnProperty(key)) { // Check if key has a property
          var diff = Date.now() - session.heartbeatsTransIds[key]; // Get time difference
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
   * Helper function for establishing connections when the SDP negotiation has been completed
   * @param  {Function} callback Callback
   */
  Session.prototype.startConnection = function(callback) {
    var session = this;

    // If the SDP negotiation has not been completed, return
    if (session.getHasNotRan || session.setHasNotRan || !session.remoteSdp || !session.localSdp) {
      MsrpSdk.Logger.debug('[MSRP Session] Unable to start connection yet. SDP negotiation in progress.');
      return;
    }

    // If the session has an active connection, return
    if (session.socket && !session.socket.destroyed) {
      MsrpSdk.Logger.warn('[MSRP Session] Session already has an active connection.');
      return;
    }

    // If inactive attribute is present, do not connect
    if (session.remoteSdp.attributes.inactive) {
      MsrpSdk.Logger.warn('[MSRP Session] Found "a=inactive" in remote endpoint SDP. Connection not needed.');
      return;
    }

    // If the local endpoint is active, connect to the remote party
    if (session.localSdp.attributes.setup[0] === 'active') {
      var remoteEndpointUri = new MsrpSdk.URI(session.remoteEndpoints[0]);
      var localEndpointUri = session.localEndpoint;

      // Do nothing if we are trying to connect to ourselves
      if (localEndpointUri.authority === remoteEndpointUri.authority) {
        MsrpSdk.Logger.warn(`[MSRP Session] Not creating a new TCP connection for session ${session.sid} because we would be talking to ourself. Returning...`);
        return;
      }

      // Create socket and connect
      MsrpSdk.Logger.debug(`[MSRP Session] Creating socket for session ${session.sid}...`);
      var socket = new MsrpSdk.SocketHandler(new net.Socket());
      socket.connect({
        host: remoteEndpointUri.authority,
        port: remoteEndpointUri.port,
        localAddress: localEndpointUri.authority,
        localPort: parseInt(localEndpointUri.port)
      }, function() {
        // Assign socket to the session
        session.setSocket(socket);
        // Send bodiless MSRP message
        var request = new MsrpSdk.Message.OutgoingRequest({
          toPath: session.remoteEndpoints,
          localUri: session.localEndpoint.uri
        }, 'SEND');
        try {
          socket.write(request.encode(), function() {
            if (callback) {
              callback();
            }
          });
        } catch (error) {
          MsrpSdk.Logger.error(`[MSRP Session] An error ocurred while sending the initial bodiless MSRP message: ${error.toString()}`);
        }
      });
    }

    // Start heartbeats if enabled and not running yet
    if (MsrpSdk.Config.enableHeartbeats !== false && !session.heartbeatPingFunc && !session.heartbeatTimeoutFunc) {
      session.startHeartbeats();
    }

    // Reset SDP negotiation flags
    session.getHasNotRan = true;
    session.setHasNotRan = true;
  };

  /**
   * Helper function for getting the local port to be used in the session
   * @param  {String} setup Local setup line content
   * @return {Number}       Local port to be used in the session
   */
  function getAssignedPort(setup) {
    return new Promise(function(resolve, reject) {
      if (setup === 'active') {
        var randomBasePort = Math.ceil(Math.random() * (configuredHighestPort - configuredBasePort)) + configuredBasePort;
        return resolve(portfinder.getPortPromise({
          port: randomBasePort,
          stopPort: configuredHighestPort
        }));
      } else {
        return resolve(MsrpSdk.Config.port);
      }
    });
  }

  MsrpSdk.Session = Session;
};
