var util = require('util');
var EventEmitter = require('events').EventEmitter;

module.exports = function(MsrpSdk) {

    var SessionController = function() {};

    util.inherits(SessionController, EventEmitter);

    var sessions = {}; // Private sessions dictionary by id

    SessionController.prototype.createSession = function() {
        var session = new MsrpSdk.Session();
        this.forwardEvents(session);
        sessions[session.sid] = session;


        // add send message
        session.sendMessage = function(msg, cb) {
            var request = new MsrpSdk.Message.OutgoingRequest({
                toPath: session.remoteEndpoints,
                localUri: session.localEndpoint.uri
            }, 'SEND');

            request.addHeader('message-id', MsrpSdk.Util.newMID());
            request.byteRange = {
                start: 1,
                end: msg.length,
                total: msg.length
            };
            request.addTextBody(msg);

            session.socket.write(request.encode(), cb);
        };

        return session;
    };

    SessionController.prototype.getSession = function(sessionId) {
        return sessions[sessionId];
    };

    // TODO: (LVM) Close socket here?
    SessionController.prototype.removeSession = function(sessionId) {
        delete sessions[sessionId];
    };

    SessionController.prototype.forwardEvents = function(session) {
        var sessionController = this;

        session.on('message', function(msg, session) {
            sessionController.emit('message', msg, session);
        });

        session.on('respose', function(msg, session) {
            sessionController.emit('respose', msg, session);
        });

        session.on('reinvite', function(session) {
            sessionController.emit('reinvite', session);
        });

        session.on('socketClose', function(hadError, session) {
            sessionController.emit('socketClose', hadError, session);
        });

        session.on('socketConnect', function(session) {
            sessionController.emit('socketConnect', session);
        });

        session.on('socketEnd', function(session) {
            sessionController.emit('socketEnd', session);
        });

        session.on('socketError', function(error, session) {
            sessionController.emit('socketError', error, session);
        });

        session.on('socketTimeout', function(session) {
            sessionController.emit('socketTimeout', session);
        });
    };

    MsrpSdk.SessionController = new SessionController();
};
