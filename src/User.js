'use strict';

module.exports = function (MsrpSdk) {

  class User {
    constructor(uri, socket, sipSession, path) {
      this.uri = new MsrpSdk.URI(uri);
      this.fullPath = path;
      this.sipSession = sipSession;
      this.socket = socket;
    }

    getSocket() {
      return this.socket;
    }

    getUri() {
      return this.uri;
    }

    getFullPath() {
      return this.fullPath;
    }

    getSipSession() {
      return this.sipSession;
    }

    supportsMessageCPIM() {
      if (!this.sipSession) {
        return false;
      }
      return this.sipSession.hasMessageCpimAcceptType();
    }
  }

  MsrpSdk.User = User;
};
