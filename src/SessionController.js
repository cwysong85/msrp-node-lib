'use strict';

// Dependencies
const { EventEmitter } = require('events');

module.exports = function (MsrpSdk) {

  /**
   * Session controller
   */
  class SessionController extends EventEmitter {
    constructor() {
      super();

      this.sessionsMap = new Map();
    }

    /**
     * Adds a new session.
     * @param {object} session - The Session instance.
     */
    addSession(session) {
      this.sessionsMap.set(session.sid, session);

      session.on('end', () => {
        this.removeSession(session);
        if (MsrpSdk.Config.forwardSessionEvents) {
          this.emit('end', session);
        }
      });

      if (MsrpSdk.Config.forwardSessionEvents) {
        forwardSessionEvents(session, this);
      }

      MsrpSdk.Logger.info(`[SessionController]: Created new session with sid=${session.sid}. Total active sessions: ${this.sessionsMap.size}`);
    }

    /**
     * Gets a session by session ID
     * @param {string} sessionId Session ID
     * @return {object} The Session instance.
     */
    getSession(sessionId) {
      return this.sessionsMap.get(sessionId);
    }

    /**
     * Removes a session
     * @param {object} session The Session instance
     */
    removeSession(session) {
      if (this.sessionsMap.has(session.sid)) {
        this.sessionsMap.delete(session.sid);
        MsrpSdk.Logger.info(`[SessionController]: Removed session with sid=${session.sid}. Total active sessions: ${this.sessionsMap.size}`);
      }
      if (!session.ended) {
        session.end();
      }
    }
  }

  /**
   * Helper function for forwarding a session's events to the session controller
   * @param {object} session The Session instance
   * @param {SessionController} sessionController Session controller
   */
  function forwardSessionEvents(session, sessionController) {
    session.on('message', message => {
      sessionController.emit('message', session, message);
    });

    // Socket events
    session.on('socketSet', () => {
      sessionController.emit('socketSet', session);
    });

    session.on('socketClose', hadError => {
      sessionController.emit('socketClose', session, hadError);
    });

    session.on('socketError', () => {
      sessionController.emit('socketError', session);
    });

    session.on('socketTimeout', () => {
      sessionController.emit('socketTimeout', session);
    });

    // Heartbeats events
    session.on('heartbeatFailure', statusCode => {
      sessionController.emit('heartbeatFailure', session, statusCode);
    });
  }

  MsrpSdk.SessionController = new SessionController();
};
