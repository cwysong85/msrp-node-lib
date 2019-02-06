var net = require('net');
var util = require('util');
var EventEmitter = require('events').EventEmitter;

module.exports = function(MsrpSdk) {

    var Session = function() {
        this.sid = MsrpSdk.Util.newSID();
        this.localEndpoint = null;
        this.remoteEndpoints = [];
        this.localSdp = null;
        this.remoteSdp = null;
        this.socket = null;
        this.reinvite = false;
        this.setup = MsrpSdk.Config.setup || 'passive';
        this.heartBeat = (MsrpSdk.Config.heartBeat !== false) ? true : false;
        this.heartBeatInterval = MsrpSdk.Config.heartBeatInterval || 5000;
        this.heartBeatTimeout = MsrpSdk.Config.heartBeatTimeout || 10000;
        this.heartBeatTransIds = {};
        this.heartBeatPingFunc = null;
        this.heartBeatTimeOutFunc = null;
        this.setHasNotRan = true;
        this.getHasNotRan = true;
        this.weArePassive = (this.setup === "passive") ? true : false;
    };

    util.inherits(Session, EventEmitter); // Sessions emit events in SocketHandler

    Session.prototype.sendMessage = function(body, cb, contentType) {

        var canSend = false;
        for (var i = this.remoteSdp.attributes.acceptTypes.length - 1; i >= 0; i--) {
            if (this.remoteSdp.attributes.acceptTypes[i] === "text/plain" || this.remoteSdp.attributes.acceptTypes[i] === "*" || this.remoteSdp.attributes.acceptTypes[i] === "text/*" || this.remoteSdp.attributes.acceptTypes[i] === "text/x-msrp-heartbeat") {
                canSend = true;
                break;
            }
        }

        if (canSend) {
            if (this.socket) {
                this.socket.emit('send', {
                    body: body,
                    contentType: contentType || "text/plain"
                }, {
                    toPath: this.remoteEndpoints,
                    localUri: this.localEndpoint.uri
                }, cb);
            } else {
                if (!this.weArePassive) {
                    // we don't have a socket set up yet, create one.
                    this.startConnection(() => {
                        this.socket.emit('send', {
                            body: body,
                            contentType: contentType || "text/plain"
                        }, {
                            toPath: this.remoteEndpoints,
                            localUri: this.localEndpoint.uri
                        }, cb);
                    })

                } else {
                    // we don't have a socket and we are not active... did the other side send a connection?
                    MsrpSdk.Logger.error('[MSRP Session] Cannot send message because there is not an active socket! Did the remote side connect? Check a=setup line in SDP media.');
                    this.emit('socketError', 'Cannot send message because there is not an active socket!', this);
                    this.emit('socketClose', true, this);
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
        this.remoteEndpoints.push(remoteEndpointUri);
    };

    Session.prototype.getDescription = function(onSuccess, onFailure, mediaHint) {
        var session = this;

        var sdp = new MsrpSdk.Sdp.Session();
        if (!sdp) {
            return;
        }

        // Origin
        sdp.origin.id = MsrpSdk.Util.dateToNtpTime(new Date());
        sdp.origin.version = sdp.origin.id;
        sdp.origin.address = MsrpSdk.Config.host;

        // Session-name
        sdp.sessionName = MsrpSdk.Config.sessionName;

        // Configuration port. Do we do TLS???
        sdp.media.push("message " + MsrpSdk.Config.port + " TCP/MSRP *");

        // Connection: If connection is present, update it
        if (sdp.connection) {
            sdp.connection.address = MsrpSdk.Config.host;
        }

        // Accept-types
        sdp.addAttribute('accept-types', MsrpSdk.Config.acceptTypes);

        // Path
        var path = 'msrp://' + MsrpSdk.Config.host + ':' + MsrpSdk.Config.port + '/' + this.sid + ';tcp';
        sdp.addAttribute('path', path);

        // Setup line
        if (session.remoteSdp) {
            // has attributes and setup line
            if (session.remoteSdp.attributes.setup) {
                if (session.remoteSdp.attributes.setup[0] === 'active' || session.remoteSdp.attributes.setup[0] === 'actpass') {
                    sdp.addAttribute('setup', 'passive');
                } else if (session.remoteSdp.attributes.setup[0] === 'passive') {
                    sdp.addAttribute('setup', 'active');
                    session.weArePassive = false;
                } else {
                    return onFailure('Invalid a=setup value');
                }
            } else {
                sdp.addAttribute('setup', 'passive');
            }
        } else {
            sdp.addAttribute('setup', session.setup);
        }

        session.localSdp = sdp;
        session.localEndpoint = new MsrpSdk.URI(path);

        session.getHasNotRan = false;
        onSuccess(sdp.toString());

        if (session.reinvite) {
            if (session.remoteSdp.attributes.setup && session.remoteSdp.attributes.setup[0] !== 'active') {
                sdp.addAttribute('setup', 'active');
                session.startConnection(function() {
                    session.emit('reinvite', session);
                    session.reinvite = false;
                });
            } else {
                session.emit('reinvite', session);
                session.reinvite = false;
            }
        } else {
            session.startConnection();
        }

    };

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
                    if (sdp.attributes.setup.length > 0 && sdp.attributes.setup[0] === "passive") {
                        session.weArePassive = false;
                    }
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
        }

        session.remoteSdp = sdp;
        session.setHasNotRan = false;
        onSuccess();
        session.startConnection();
    };

    Session.prototype.end = function() {
        var session = this
        session.stopHeartBeat()
        if (session.socket) {
            session.socket.end();
        }
    };

    Session.prototype.stopHeartBeat = function() {
        var session = this
        clearInterval(session.heartBeatPingFunc)
        MsrpSdk.Logger.debug("Stopping MSRP Heartbeats")
        clearInterval(session.heartBeatTimeOutFunc)
        session.heartBeatPingFunc = null
        session.heartBeatTimeOutFunc = null
    };

    Session.prototype.startHeartBeat = function(interval, timeOutInterval) {
        var session = this;
        var ping = function() {
            session.sendMessage("HEARTBEAT", function() {}, "text/x-msrp-heartbeat")
        };
        session.heartBeatPingFunc = setInterval(ping, interval);
        var timeOut = function() {
            for (var key in session.heartBeatTransIds) { //loop through all heartbeats
                if (session.heartBeatTransIds.hasOwnProperty(key)) { //check if key has a property
                    var date = new Date
                    diff = (date.getTime() - session.heartBeatTransIds[key]) //get time difference
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

        if (session.getHasNotRan || session.setHasNotRan) {
            return;
        }

        if (!session.remoteSdp || !session.localSdp) {
            return;
        }


        // setTimeout(function() {
        if (!session.weArePassive) {

            // are we talking to ourselves???
            // do a quick check to see if we are trying to connect to ourself.
            if (session.remoteEndpoints[0] === session.localEndpoint) {
                MsrpSdk.Logger.warn("Not creating a new TCP connection for session because we would be talking to ourself. Returing...");
                return;
            }

            // We are active, lets create a socket to them
            var remoteEndpointUri = new MsrpSdk.URI(session.remoteEndpoints[0]);
            var socket = new net.Socket();
            session.socket = new MsrpSdk.SocketHandler(socket);

            socket.connect(remoteEndpointUri.port, remoteEndpointUri.authority, function() {

                // TODO: (LVM) Our bodiless message is different to the one the client send us.
                // Send bodiless MSRP message
                var request = new MsrpSdk.Message.OutgoingRequest({
                    toPath: session.remoteEndpoints,
                    localUri: session.localEndpoint.uri
                }, 'SEND');

                try {
                    socket.write(request.encode(), function() {
                        if (cb) {
                            cb()
                        };
                    });
                } catch (e) {
                    MsrpSdk.Logger.error(e);
                }

                if (session.heartBeat) {
                    session.startHeartBeat(session.heartBeatInterval)
                }
            });
        }
    };

    MsrpSdk.Session = Session;
};
