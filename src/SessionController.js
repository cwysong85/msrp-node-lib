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
        return session;
    };

    SessionController.prototype.getSession = function(sessionId) {
        return sessions[sessionId];
    };

    SessionController.prototype.removeSession = function(sessionId) {
        delete sessions[sessionId];
    };

    SessionController.prototype.forwardEvents = function(session) {
        var sessionController = this;

        session.on('message', function(msg, session) {
            sessionController.emit('message', msg, session);
        });

        session.on('response', function(msg, session) {
            sessionController.emit('response', msg, session);
        });

        session.on('reinvite', function(session) {
            sessionController.emit('reinvite', session);
        });

        session.on('socketClose', function(hadError, session) {
            sessionController.emit('socketClose', hadError, session);
            if(session) {
              try {
                sessionController.removeSession(session.sid);
              } catch(e) { 
                MsrpSdk.Logger.error(e)
              }
            }
        });

        session.on('socketConnect', function(session) {
            sessionController.emit('socketConnect', session);
        });

        session.on('socketEnd', function(session) {
            sessionController.emit('socketEnd', session);
            if(session) {
              try {
                sessionController.removeSession(session.sid);
              } catch(e) { }
            }
        });

        session.on('socketError', function(error, session) {
            sessionController.emit('socketError', error, session);
            if(session) {
              try {
                sessionController.removeSession(session.sid);
              } catch(e) { }
            }
        });

        session.on('socketTimeout', function(session) {
            sessionController.emit('socketTimeout', session);
            if(session) {
              try {
                sessionController.removeSession(session.sid);
              } catch(e) { }
            }
        });
    };

    MsrpSdk.SessionController = new SessionController();
};
