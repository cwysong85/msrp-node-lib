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
        this.setup = MsrpSdk.Config.setup;
        this.setHasNotRan = true;
        this.getHasNotRan = true;
    };

    util.inherits(Session, EventEmitter); // Sessions emit events in SocketHandler

    Session.prototype.sendMessage = function(body, cb) {
        this.socket.emit('send', {
            body: body,
            contentType: this.remoteSdp.attributes.acceptTypes.join(' ')
        }, {
            toPath: this.remoteEndpoints,
            localUri: this.localEndpoint.uri
        }, cb);
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
                if (session.remoteSdp.attributes.setup[0] === 'active') {
                    sdp.addAttribute('setup', 'passive');
                } else if (session.remoteSdp.attributes.setup[0] === 'passive' || session.remoteSdp.attributes.setup[0] === 'actpass') {
                    sdp.addAttribute('setup', 'active');
                } else {
                    return onFailure('Invalid a=setup value');
                }
            } else {
                sdp.addAttribute('setup', 'active');
            }
        } else {
            sdp.addAttribute('setup', session.setup);
        }

        session.localSdp = sdp;
        session.localEndpoint = new MsrpSdk.URI(path);

        session.getHasNotRan = false;

        if (session.reinvite) {
            if (session.remoteSdp.attributes.setup[0] !== 'active') {
                sdp.addAttribute('setup', 'active');
                session.startConnection(function() {
                    // console.log('REINVITING');
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

        onSuccess(sdp.toString());
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
                } else {
                    sdp.attributes.setup = ['passive'];
                }
            } else {
                sdp.attributes.setup = ['passive'];
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
        session.startConnection();
        onSuccess();
    };

    Session.prototype.end = function() {
        if (this.socket) {
            this.socket.end();
        }
    };

    Session.prototype.startConnection = function(cb) {
        var session = this;

        if (session.getHasNotRan || session.setHasNotRan) {
            return;
        }

        if (!session.remoteSdp) {
            return;
        }

        if (session.remoteSdp.attributes.setup[0] !== 'active') {
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
                    console.log(e);
                }
            });
        }
    };

    MsrpSdk.Session = Session;
};
