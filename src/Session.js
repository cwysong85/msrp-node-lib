// Dependencies
var net = require('net');
var util = require('util');
var portfinder = require('portfinder');
var EventEmitter = require('events').EventEmitter;


module.exports = function(MsrpSdk) {

  // TODO: (LVM55) REVIEW
  portfinder.basePort = MsrpSdk.Config.basePort;
  portfinder.highestPort = MsrpSdk.Config.highestPort;

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

  Session.prototype.sendMessage = function(body, cb, contentType) {
    var session = this;

    // See if we can send this content type to the remote client
    var ct = contentType || 'text/plain';
    var canSend = session.remoteSdp.attributes.acceptTypes.some(function(acceptType) {
      return (acceptType === ct || acceptType === '*');
    });

    if (canSend) {
      if (session.socket) {
        session.socket.emit('send', {
          body: body,
          contentType: ct
        }, {
          toPath: session.remoteEndpoints,
          localUri: session.localEndpoint.uri
        }, cb);
      } else {
        if (session.localSdp && session.localSdp.attributes.setup[0] !== 'passive') {
          // we don't have a socket set up yet, create one.

          // TODO: (LVM44) TEST
          MsrpSdk.Logger.debug('---> CONNECTING A SOCKET HERE??? I THINK THIS NEVER HAPPENS.');

          session.startConnection(function() {
            session.socket.emit('send', {
              body: body,
              contentType: ct
            }, {
              toPath: session.remoteEndpoints,
              localUri: session.localEndpoint.uri
            }, cb);
          });
        } else {
          // we don't have a socket and we are not active... did the other side send a connection?
          MsrpSdk.Logger.error('[MSRP Session] Cannot send message because there is not an active socket! Did the remote side connect? Check a=setup line in SDP media.');
          session.emit('socketError', 'Cannot send message because there is not an active socket!', session);
          session.emit('socketClose', true, session);
          return;
        }
      }
    } else {
      MsrpSdk.Logger.warn('[MSRP Session] Cannot send message due to incompatible content types exchanged in SDP');
      return;
    }
  };

  Session.prototype.getRemoteEndpoint = function(remoteEndpointUri) {
    var session = this;
    for (var i = 0; i < session.remoteEndpoints.length; i++) {
      if (session.remoteEndpoints[i] === remoteEndpointUri) {
        return session.remoteEndpoints[i];
      }
    }
  };

  Session.prototype.addRemoteEndpoint = function(remoteEndpointUri) {
    var session = this;
    session.remoteEndpoints.push(remoteEndpointUri);
  };

  /**
   * Helper method called during the SDP negotiation to create the local SDP.
   * @param  {Function} onSuccess onSuccess callback
   * @param  {Function} onFailure onFailure callback
   * @param  {Object}   mediaHint SIPjs parameter. Not used here.
   */
  Session.prototype.getDescription = function(onSuccess, onFailure, mediaHint) {
    var session = this;

    // TODO: (LVM55)
    if (session.reinvite) {
      MsrpSdk.Logger.debug('---> REINVITE GETDESCRIPTION');
    }

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
    // Setup line
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
    // We need to know the local port for configuring the path and the port
    getAssignedPort(localSdp.attributes.setup[0])
      .then(function(assignedPort) {
        // Path
        var path = 'msrp://' + MsrpSdk.Config.host + ':' + assignedPort + '/' + session.sid + ';tcp';
        localSdp.addAttribute('path', path);
        // Port
        localSdp.media.push('message ' + assignedPort + ' TCP/MSRP *');

        // Update session information
        session.localSdp = localSdp;
        session.localEndpoint = new MsrpSdk.URI(path);
        session.getHasNotRan = false;

        // Success
        onSuccess(localSdp.toString());

        // TODO: (LVM55) REINVITEs logic
        if (session.reinvite) {
          // TODO: (LVM55)
          MsrpSdk.Logger.debug('---> REINVITE SETUP:', session.localSdp.attributes.setup[0]);

          if (session.localSdp.attributes.setup[0] === 'active') {
            // TODO: (LVM55)
            MsrpSdk.Logger.debug('---> ACTIVE REINVITE!!!');
            // TODO: (LVM55)
            // localSdp.addAttribute('setup', 'active');
            session.startConnection(function() {
              // TODO: (LVM55)
              MsrpSdk.Logger.debug('---> CONNECTION STARTED AFTER REINVITE!!!');
              session.emit('reinvite', session);
              session.reinvite = false;
            });
          } else {
            // TODO: (LVM55)
            MsrpSdk.Logger.debug('---> PASSIVE REINVITE!!!');
            session.emit('reinvite', session);
            session.reinvite = false;
          }
        } else {
          session.startConnection();
        }
      })
      .catch(function(error) {
        MsrpSdk.Logger.error('[MSRP Session] An error ocurred while creating the local SDP:', error);
        return;
      });
  };

  /**
   * Helper method called during the SDP negotiation to set the remote SDP.
   * @param  {String}   description Remote description
   * @param  {Function} onSuccess   onSuccess callback
   * @param  {Function} onFailure   onFailure callback
   */
  Session.prototype.setDescription = function(description, onSuccess, onFailure) {
    var session = this;

    // pass to SDP parser, create a room, get SDP answer
    var sdp = new MsrpSdk.Sdp.Session(description);

    // check to see if remote is active or passive
    for (var i = 0; i < sdp.media.length; i++) {
      // If client doesn't have the setup line its most likely wrong
      // RFC 4975 states that if a MSRP client initiates a connection it should therefore be active
      // unless it cannot be active, therefore set the "setup" attribute to "passive"
      //
      // draft-pd-dispatch-msrp-websocket-08 doesn't have the active, passive, actpass attribute defined
      // it might be a good idea to have the relay add this to SDP or build it into the MSRP SDP

      if (sdp.media[i].attributes) {
        if (sdp.media[i].attributes.setup) {
          sdp.attributes.setup = sdp.media[i].attributes.setup;
          // TODO: (LVM44) REVIEW AND REMOVE
          // if (sdp.attributes.setup.length > 0 && sdp.attributes.setup[0] === 'passive') {
          //   session.weArePassive = false;
          // }
        }
      }

      if (sdp.media[i].attributes.path) {
        sdp.attributes.path = sdp.media[i].attributes.path[0].split(' ');
        session.remoteEndpoints = sdp.attributes.path;
      }

      if (sdp.media[i].attributes['accept-types']) {
        sdp.attributes.acceptTypes = sdp.media[i].attributes['accept-types'][0].split(' ');
      }
    }

    if (session.remoteSdp) {
      session.reinvite = true;

      // TODO: (LVM55)
      MsrpSdk.Logger.debug('---> REINVITE SETDESCRIPTION');
    }

    session.remoteSdp = sdp;
    session.setHasNotRan = false;
    onSuccess();
    session.startConnection();
  };

  Session.prototype.end = function() {
    var session = this;
    session.stopHeartBeat();
    if (session.socket) {
      session.socket.end();
    }
  };

  Session.prototype.stopHeartBeat = function() {
    var session = this;
    clearInterval(session.heartBeatPingFunc);
    MsrpSdk.Logger.debug('Stopping MSRP Heartbeats...');
    clearInterval(session.heartBeatTimeOutFunc);
    session.heartBeatPingFunc = null;
    session.heartBeatTimeOutFunc = null;
  };

  Session.prototype.startHeartBeat = function(interval, timeOutInterval) {
    var session = this;
    var ping = function() {
      session.sendMessage('HEARTBEAT', function() {}, 'text/x-msrp-heartbeat');
    };
    session.heartBeatPingFunc = setInterval(ping, interval);
    var timeOut = function() {
      for (var key in session.heartBeatTransIds) { //loop through all heartbeats
        if (session.heartBeatTransIds.hasOwnProperty(key)) { //check if key has a property
          var date = new Date();
          diff = (date.getTime() - session.heartBeatTransIds[key]); //get time difference
          if (diff > timeOutInterval) { //if the difference is greater than timeout
            session.emit('socketClose', true, session); //close socket
          }
        }
      }
    };
    session.heartBeatTimeOutFunc = setInterval(timeOut, 1000); //Check for a failed heartbeat every 1 second
  };



  Session.prototype.startConnection = function(cb) {
    var session = this;

    // TODO: (LVM55) REMOVE TRACES
    MsrpSdk.Logger.debug('---> START CONNECTION');
    MsrpSdk.Logger.debug('---> getHasNotRan:', session.getHasNotRan);
    MsrpSdk.Logger.debug('---> setHasNotRan:', session.setHasNotRan);

    if (session.getHasNotRan || session.setHasNotRan) {
      return;
    }

    if (!session.remoteSdp || !session.localSdp) {
      return;
    }

    // TODO: (LVM44) REMOVE TRACES
    var remoteEndpointUri1 = new MsrpSdk.URI(session.remoteEndpoints[0]);
    var localEndpointUri1 = session.localEndpoint;
    MsrpSdk.Logger.debug('---> remoteEndpointUri1:', remoteEndpointUri1);
    MsrpSdk.Logger.debug('---> localEndpointUri1:', localEndpointUri1);
    MsrpSdk.Logger.debug('---> ARE WE ACTIVE:', session.localSdp.attributes.setup[0] === 'active');

    // TODO: (LVM44) TEST
    if (session.localSdp.attributes.setup[0] === 'active') {
      // are we talking to ourselves???
      // do a quick check to see if we are trying to connect to ourself.

      // TODO: (LVM44) Connecting to ourselves?
      // if (session.remoteEndpoints[0] === session.localEndpoint) {
      if (localEndpointUri1.authority === remoteEndpointUri1.authority) {
        MsrpSdk.Logger.warn('Not creating a new TCP connection for session because we would be talking to ourself. Returning...');
        return;
      }

      // We are active, lets create a socket to them
      var remoteEndpointUri = new MsrpSdk.URI(session.remoteEndpoints[0]);
      var localEndpointUri = session.localEndpoint;

      // TODO: (LVM44) Create the socket during the SDP creation
      var socket = new net.Socket();
      session.socket = new MsrpSdk.SocketHandler(socket);

      // TODO: (LVM44)
      // socket.connect(remoteEndpointUri.port, remoteEndpointUri.authority, function() {
      socket.connect({
        host: remoteEndpointUri.authority,
        port: remoteEndpointUri.port,
        localAddress: localEndpointUri.authority,
        localPort: parseInt(localEndpointUri.port)
      }, function() {
        // TODO: (LVM55)
        MsrpSdk.Logger.info('---> OUTBOUND SOCKET CONNECTED');
        MsrpSdk.Logger.info('---> LOCAL SETUP:', session.localSdp.attributes.setup[0]);
        if (session.remoteSdp.attributes.setup) {
          MsrpSdk.Logger.info('---> REMOTE SETUP:', session.remoteSdp.attributes.setup[0]);
        } else {
          MsrpSdk.Logger.info('---> REMOTE SETUP: DEFAULT');
        }
        MsrpSdk.Logger.info('---> LOCAL ENDPOINT: %s:%s', localEndpointUri.authority, localEndpointUri.port);
        MsrpSdk.Logger.info('---> LOCAL SOCKET: %s:%s', socket.localAddress, socket.localPort);
        MsrpSdk.Logger.info('---> REMOTE ENDPOINT: %s:%s', remoteEndpointUri.authority, remoteEndpointUri.port);
        MsrpSdk.Logger.info('---> REMOTE SOCKET: %s:%s', socket.remoteAddress, socket.remotePort);

        // TODO: (LVM) Our bodiless message is different to the one the client send us.
        // Send bodiless MSRP message
        var request = new MsrpSdk.Message.OutgoingRequest({
          toPath: session.remoteEndpoints,
          localUri: session.localEndpoint.uri
        }, 'SEND');

        try {
          socket.write(request.encode(), function() {
            if (cb) {
              cb();
            }
          });
        } catch (e) {
          MsrpSdk.Logger.error(e);
        }

        if (session.heartBeat) {
          session.startHeartBeat(session.heartBeatInterval);
        }
      });
    }

    // TODO: (LVM55) Reset flags for reinvites
    // TODO: (LVM55) Maybe this flags can be checked before calling startConnection. Easier to read.
    session.getHasNotRan = true;
    session.setHasNotRan = true;
  };

  function getAssignedPort(setup) {
    return new Promise(function(resolve, reject) {
      if (setup === 'active') {
        // TODO: (LVM44) Race conditions here?
        return resolve(portfinder.getPortPromise());
      } else {
        return resolve(MsrpSdk.Config.port);
      }
    });
  }

  MsrpSdk.Session = Session;
};
