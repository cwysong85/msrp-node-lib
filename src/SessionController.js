// Dependencies
const util = require('util');
const EventEmitter = require('events').EventEmitter;

module.exports = function(MsrpSdk) {

  /**
   * Session controller
   */
  const SessionController = function() {
    this.sessions = []; // Sessions array
  };
  util.inherits(SessionController, EventEmitter);

  /**
   * Creates a session
   * @return {Session} Session
   */
  SessionController.prototype.createSession = function() {
    const sessionController = this;
    const session = new MsrpSdk.Session();
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
    const sessionController = this;
    return sessionController.sessions.find(function(session) {
      return session.sid === sessionId;
    });
  };

  /**
   * Gets sessions by remote socket address
   * @param  {String} socketAddress Socket address
   * @return {Array<Session>}       Sessions
   */
  SessionController.prototype.getSessionsByRemoteSocketAddress = function(socketAddress) {
    const sessionController = this;
    return sessionController.sessions.filter(function(session) {
      const remoteEndpointUri = new MsrpSdk.URI(session.remoteEndpoints[0]);
      return `${remoteEndpointUri.authority}:${remoteEndpointUri.port}` === socketAddress;
    });
  };

  /**
   * Removes a session
   * @param  {Session} session Session
   */
  SessionController.prototype.removeSession = function(session) {
    const sessionController = this;
    if (sessionController.sessions.includes(session)) {
      sessionController.sessions.splice(sessionController.sessions.indexOf(session), 1);
    }
    session.end();
  };

  /**
   * Helper function for forwarding a session's events to the session controller
   * @param  {Session} session Session
   * @param  {SessionController} sessionController Session controller
   */
  function forwardSessionEvents(session, sessionController) {
    // Session events
    session.on('end', function(session) {
      sessionController.emit('end', session);
    });

    session.on('message', function(message, session, encodedMessage) {
      sessionController.emit('message', message, session, encodedMessage);
    });

    session.on('messageSent', function(message, session, encodedMessage) {
      sessionController.emit('messageSent', message, session, encodedMessage);
    });

    session.on('response', function(response, session, encodedResponse) {
      sessionController.emit('response', response, session, encodedResponse);
    });

    session.on('responseSent', function(response, session, encodedResponse) {
      sessionController.emit('responseSent', response, session, encodedResponse);
    });

    session.on('report', function(report, session, encodedReport) {
      sessionController.emit('report', report, session, encodedReport);
    });

    session.on('reportSent', function(report, session, encodedReport) {
      sessionController.emit('reportSent', report, session, encodedReport);
    });

    session.on('update', function(session) {
      sessionController.emit('update', session);
    });

    // Socket events
    session.on('socketClose', function(hadError, session) {
      sessionController.emit('socketClose', hadError, session);
    });

    session.on('socketError', function(session) {
      sessionController.emit('socketError', session);
    });

    session.on('socketSet', function(session) {
      sessionController.emit('socketSet', session);
    });

    session.on('socketConnectTimeout', function(session) {
      sessionController.emit('socketConnectTimeout', session);
    });

    session.on('idleSocketTimeout', function(session) {
      sessionController.emit('idleSocketTimeout', session);
    });

    session.on('socketReconnectTimeout', function(session) {
      sessionController.emit('socketReconnectTimeout', session);
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
