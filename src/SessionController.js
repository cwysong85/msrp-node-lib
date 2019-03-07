// Dependencies
var util = require('util');
var EventEmitter = require('events').EventEmitter;

module.exports = function(MsrpSdk) {

  /**
   * Session controller
   */
  var SessionController = function() {
    this.sessions = []; // Sessions array
  };
  util.inherits(SessionController, EventEmitter);

  /**
   * Creates a session
   * @return {Session} Session
   */
  SessionController.prototype.createSession = function() {
    var sessionController = this;
    var session = new MsrpSdk.Session();
    forwardSessionEvents(session, sessionController);
    sessionController.sessions.push(session);
    return session;
  };

  /**
   * Gets a session by session ID
   * @param  {String} sessionId Session ID
   * @return {Session}          Session
   */
  SessionController.prototype.getSession = function(sessionId) {
    var sessionController = this;
    return sessionController.sessions.find(function(session) {
      return session.sid === sessionId;
    });
  };

  /**
   * Removes a session
   * @param  {Session} session Session
   */
  SessionController.prototype.removeSession = function(session) {
    var sessionController = this;
    if (sessionController.sessions.includes(session)) {
      sessionController.sessions.splice(sessionController.sessions.indexOf(session), 1);
    }
  };

  /**
   * Helper function for forwarding a session's events to the session controller
   * @param  {Session} session Session
   * @param  {SessionController} sessionController Session controller
   */
  function forwardSessionEvents(session, sessionController) {
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
      sessionController.removeSession(session);
      sessionController.emit('socketClose', hadError, session);
    });

    session.on('socketConnect', function(session) {
      sessionController.emit('socketConnect', session);
    });

    session.on('socketError', function(error, session) {
      sessionController.removeSession(session);
      sessionController.emit('socketError', error, session);
    });

    session.on('socketTimeout', function(session) {
      sessionController.removeSession(session);
      sessionController.emit('socketTimeout', session);
    });
  }

  MsrpSdk.SessionController = new SessionController();
};
