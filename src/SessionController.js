// Dependencies
var util = require('util');
var EventEmitter = require('events').EventEmitter;

module.exports = function(MsrpSdk) {

  /**
   * Session controller
   */
  var SessionController = function() {
    this.sessionsMap = new Map();
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
    sessionController.sessionsMap.set(session.sid, session);
    MsrpSdk.Logger.info(`[MSRP SessionController] Created new session with sid=${session.sid}. Total active sessions: ${sessionController.sessionsMap.size}`);
    return session;
  };

  /**
   * Gets a session by session ID
   * @param  {String} sessionId Session ID
   * @return {Session}          Session
   */
  SessionController.prototype.getSession = function(sessionId) {
    var sessionController = this;
    return sessionController.sessionsMap.get(sessionId);
  };

  /**
   * Removes a session
   * @param  {Session} session Session
   */
  SessionController.prototype.removeSession = function(session) {
    var sessionController = this;
    sessionController.sessionsMap.delete(session.sid);
    session.end();
    MsrpSdk.Logger.info(`[MSRP SessionController] Ended session with sid=${session.sid}. Total active sessions: ${sessionController.sessionsMap.size}`);
  };

  /**
   * Checks if the socket for the given session is used by another session.
   * @param  {Session} session Session
   * @returns {boolean} Returns true if socket is reused
   */
  SessionController.prototype.isSocketReused = function(session) {
    var sessionController = this;
    for (const sessionItem of sessionController.sessionsMap.values()) {
      if (sessionItem !== session && sessionItem.socket === session.socket) {
        return true;
      }
    }
    return false;
  };

  /**
   * Helper function for forwarding a session's events to the session controller
   * @param  {Session} session Session
   * @param  {SessionController} sessionController Session controller
   */
  function forwardSessionEvents(session, sessionController) {
    // Session events
    session.on('end', function(session) {
      sessionController.removeSession(session);
      sessionController.emit('end', session);
    });

    session.on('message', function(message, session) {
      sessionController.emit('message', message, session);
    });

    // TODO: Deprecated
    session.on('reinvite', function(session) {
      sessionController.emit('reinvite', session);
    });

    session.on('update', function(session) {
      sessionController.emit('update', session);
    });

    // Socket events
    session.on('socketClose', function(hadError, session) {
      sessionController.emit('socketClose', hadError, session);
    });

    // TODO: Deprecated
    session.on('socketConnect', function(session) {
      sessionController.emit('socketConnect', session);
    });

    session.on('socketError', function(session) {
      sessionController.emit('socketError', session);
    });

    session.on('socketSet', function(session) {
      sessionController.emit('socketSet', session);
    });

    session.on('socketTimeout', function(session) {
      sessionController.emit('socketTimeout', session);
    });

    // Heartbeats events
    session.on('heartbeatFailure', function(session) {
      sessionController.emit('heartbeatFailure', session);
    });

    session.on('heartbeatTimeout', function(session) {
      sessionController.emit('heartbeatTimeout', session);
    });
  }

  MsrpSdk.SessionController = new SessionController();
};
