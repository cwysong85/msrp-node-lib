// Dependencies
var net = require('net');
var util = require('util');
var portfinder = require('portfinder');
var EventEmitter = require('events').EventEmitter;

module.exports = function(MsrpSdk) {
  // Load needed configuration
  portfinder.basePort = MsrpSdk.Config.outboundBasePort || 40000;
  portfinder.highestPort = MsrpSdk.Config.outboundHighestPort || 60000;

  // TODO: (LVM) Maybe we can move the heartbeat related properties out of the MSRP Session class
  // since they are fixed general configuration parameters
  /**
   * MSRP Session
   * @class
   * @property {String} sid Session ID
   * @property {Object} localEndpoint URI object describing the local endpoint
   * @property {Array<String>} remoteEndpoints Array of remote endpoints
   * @property {Object} localSdp SDP object contanining the local SDP
   * @property {Object} remoteSdp SDP object contanining the remote SDP
   * @property {Object} socket Session socket
   * @property {Boolean} reinvite Flag that indicates if a re-INVITE has just been received
   * @property {Boolean} heartBeat Flag for enabling/disabling heartbeats
   * @property {Number} heartBeatInterval Interval for heartbeats
   * @property {Number} heartBeatTimeout Timeout for heartbeats
   * @property {Object} heartBeatTransIds Disctionary of heartbeats transaction IDs
   * @property {Function} heartBeatPingFunc Ping function for heartbeats
   * @property {Function} heartBeatTimeOutFunc Timeout function for heartbeats
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
    this.reinvite = false;
    this.heartBeat = (MsrpSdk.Config.heartBeat !== false) ? true : false;
    this.heartBeatInterval = MsrpSdk.Config.heartBeatInterval || 5000;
    this.heartBeatTimeout = MsrpSdk.Config.heartBeatTimeout || 10000;
    this.heartBeatTransIds = {};
    this.heartBeatPingFunc = null;
    this.heartBeatTimeOutFunc = null;
    this.setHasNotRan = true;
    this.getHasNotRan = true;
  };

  util.inherits(Session, EventEmitter); // Sessions emit events in SocketHandler

  /**
   * Sends an MSRP Message to the Session's remote party
   * @param  {String}   body        Message body
   * @param  {Function} callback    Callback function
   * @param  {String}   contentType Message Content-Type
   */
  Session.prototype.sendMessage = function(body, callback, contentType) {
    var session = this;

    // See if we can send this Content-Type to the remote client
    contentType = contentType || 'text/plain';
    var canSend = session.remoteSdp.attributes.acceptTypes.some(function(acceptType) {
      return (acceptType === contentType || acceptType === '*');
    });

    if (canSend) {
      if (session.socket) {
        session.socket.emit('send', {
          body: body,
          contentType: contentType
        }, {
          toPath: session.remoteEndpoints,
          localUri: session.localEndpoint.uri
        }, callback);
      } else {
        // We don't have a socket. Did the other side send a connection?
        MsrpSdk.Logger.error('[MSRP Session] Cannot send message because there is not an active socket! Did the remote side connect? Check a=setup line in SDP media.');
        session.emit('socketError', 'Cannot send message because there is not an active socket!', session);
        session.emit('socketClose', true, session);
        return;
      }
    } else {
      MsrpSdk.Logger.warn('[MSRP Session] Cannot send message due to incompatible content types exchanged in SDP');
      return;
    }
  };

  /**
   * Function called during the SDP negotiation to create the local SDP.
   * @param  {Function} onSuccess onSuccess callback
   * @param  {Function} onFailure onFailure callback
   * @param  {Object}   mediaHint SIPjs parameter
   */
  Session.prototype.getDescription = function(onSuccess, onFailure, mediaHint) {
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

        // Extra logic for re-INVITEs
        var callback;
        if (session.reinvite) {
          // Emit reinvite event after calling startConnection
          callback = function() {
            session.emit('reinvite', session);
          };
          // Reset reinvite flag
          session.reinvite = false;
        }

        // Start connection if needed
        session.startConnection(callback);
      })
      .catch(function(error) {
        MsrpSdk.Logger.error('[MSRP Session] An error ocurred while creating the local SDP:', error);
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

    // Attributes
    for (var i = 0; i < remoteSdp.media.length; i++) {
      // Setup
      // NOTE: RFC 4975 states that if a MSRP client initiates a connection it should therefore be active
      // unless it cannot be active, therefore set the "setup" attribute to "passive"
      // NOTE: draft-pd-dispatch-msrp-websocket-08 doesn't have the active, passive, actpass attribute defined
      // TODO: (LVM) We are looping though media objects and overwritting parameters. I think this is not right.
      if (remoteSdp.media[i].attributes) {
        if (remoteSdp.media[i].attributes.setup) {
          remoteSdp.attributes.setup = remoteSdp.media[i].attributes.setup;
        }
      }
      // Path and session's remote endpoints
      if (remoteSdp.media[i].attributes.path) {
        remoteSdp.attributes.path = remoteSdp.media[i].attributes.path[0].split(' ');
      }
      // Accept-types
      if (remoteSdp.media[i].attributes['accept-types']) {
        remoteSdp.attributes.acceptTypes = remoteSdp.media[i].attributes['accept-types'][0].split(' ');
      }
    }

    // Success! Remote SDP processed
    onSuccess();

    // If we already had a remote SDP, this is a re-INVITE
    if (session.remoteSdp) {
      session.reinvite = true;
    }

    // Update session information
    session.remoteSdp = remoteSdp;
    session.remoteEndpoints = remoteSdp.attributes.path;
    session.setHasNotRan = false;

    // Start connection if needed
    session.startConnection();
  };

  /**
   * Ends a session
   */
  Session.prototype.end = function() {
    var session = this;
    MsrpSdk.Logger.debug('[MSRP Session] Ending MSRP session %s...', session.sid);
    if (MsrpSdk.Config.heartBeat !== false) {
      session.stopHeartBeat();
    }
    if (session.socket) {
      session.socket.end();
    }
  };

  /**
   * Stops MSRP heartbeats
   */
  Session.prototype.stopHeartBeat = function() {
    var session = this;
    MsrpSdk.Logger.debug('[MSRP Session] Stopping MSRP heartbeats for session %s...', session.sid);
    clearInterval(session.heartBeatPingFunc);
    clearInterval(session.heartBeatTimeOutFunc);
    session.heartBeatPingFunc = null;
    session.heartBeatTimeOutFunc = null;
  };

  /**
   * Starts MSRP heartbeats
   * @param  {Number} interval        Ping interval
   * @param  {Number} timeOutInterval Time out interval
   */
  Session.prototype.startHeartBeat = function(interval, timeOutInterval) {
    var session = this;
    MsrpSdk.Logger.debug('[MSRP Session] Starting MSRP heartbeats for session %s...', session.sid);
    var ping = function() {
      session.sendMessage('HEARTBEAT', function() {}, 'text/x-msrp-heartbeat');
    };
    session.heartBeatPingFunc = setInterval(ping, interval);
    var timeOut = function() {
      for (var key in session.heartBeatTransIds) { // Loop through all heartbeats
        if (session.heartBeatTransIds.hasOwnProperty(key)) { // Check if key has a property
          var date = new Date();
          diff = (date.getTime() - session.heartBeatTransIds[key]); // Get time difference
          if (diff > timeOutInterval) { // If the difference is greater than timeout
            session.emit('socketClose', true, session); // close socket
          }
        }
      }
    };
    session.heartBeatTimeOutFunc = setInterval(timeOut, 1000); // Check for a failed heartbeat every 1 second
  };

  /**
   * Helper function for establishing connections when the SDP negotiation has been completed
   * @param  {Function} callback Callback
   */
  Session.prototype.startConnection = function(callback) {
    var session = this;

    // If the SDP negotiation has not been completed, or any of the needed SDPs are missing, execute the callback and return
    if (session.getHasNotRan || session.setHasNotRan || !session.remoteSdp || !session.localSdp) {
      if (callback) {
        callback();
      }
      return;
    }

    // If the local endpoint is active, connect to the remote party
    if (session.localSdp.attributes.setup[0] === 'active') {
      var remoteEndpointUri = new MsrpSdk.URI(session.remoteEndpoints[0]);
      var localEndpointUri = session.localEndpoint;

      // Do nothing if we are trying to connect to ourselves
      if (localEndpointUri.authority === remoteEndpointUri.authority) {
        MsrpSdk.Logger.warn('[MSRP Session] Not creating a new TCP connection for session %s because we would be talking to ourself. Returning...', session.sid);
        return;
      }

      // Create socket and connect
      MsrpSdk.Logger.debug('[MSRP Session] Creating socket for session %s...', session.sid);
      var socket = new net.Socket();
      session.socket = new MsrpSdk.SocketHandler(socket);
      socket.connect({
        host: remoteEndpointUri.authority,
        port: remoteEndpointUri.port,
        localAddress: localEndpointUri.authority,
        localPort: parseInt(localEndpointUri.port)
      }, function() {
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
          MsrpSdk.Logger.error('[MSRP Session] An error ocurred while sending the initial bodyless MSRP message:', error);
        }

        // Start heartbeats if enabled
        if (session.heartBeat) {
          session.startHeartBeat(session.heartBeatInterval);
        }
      });
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
        return resolve(portfinder.getPortPromise());
      } else {
        return resolve(MsrpSdk.Config.port);
      }
    });
  }

  MsrpSdk.Session = Session;
};
