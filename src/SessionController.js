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
     * Adds a new session
     * @param {Session} Session
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
     * @param  {String} sessionId Session ID
     * @return {Session}          Session
     */
    getSession(sessionId) {
      return this.sessionsMap.get(sessionId);
    }

    /**
     * Removes a session
     * @param  {Session} session Session
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

    /**
     * Checks if the socket for the given session is used by another session.
     * @param  {Session} session Session
     * @returns {boolean} Returns true if socket is reused
     */
    isSocketReused(session) {
      for (const sessionItem of this.sessionsMap.values()) {
        if (sessionItem !== session && sessionItem.socket === session.socket) {
          return true;
        }
      }
      return false;
    }
  }

  /**
   * Helper function for forwarding a session's events to the session controller
   * @param  {Session} session Session
   * @param  {SessionController} sessionController Session controller
   */
  function forwardSessionEvents(session, sessionController) {
    session.on('message', message => {
      sessionController.emit('message', session, message);
    });

    session.on('update', () => {
      sessionController.emit('update', session);
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
    session.on('heartbeatFailure', () => {
      sessionController.emit('heartbeatFailure', session);
    });

    session.on('heartbeatTimeout', () => {
      sessionController.emit('heartbeatTimeout', session);
    });
  }

  MsrpSdk.SessionController = new SessionController();
};
