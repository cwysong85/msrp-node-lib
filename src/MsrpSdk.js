var MsrpSdk = {};

module.exports = function(config = {}, logger = null) {

  // Set configuration
  config.port = config.port || 2855;
  config.host = config.host || '127.0.0.1';
  config.signalingHost = config.signalingHost || config.host;

  MsrpSdk.Config = config;
  MsrpSdk.Logger = logger || console;

  if (!MsrpSdk.Logger.warn) {
    if (typeof MsrpSdk.Logger.warning === "function") {
      MsrpSdk.Logger.warn = MsrpSdk.Logger.warning;
    } else {
      MsrpSdk.Logger.warn = console.warn;
    }
  }

  if (!MsrpSdk.Logger.info) {
    MsrpSdk.Logger.info = console.log;
  }

  // Gather MSRP library elements
  require('./Status.js')(MsrpSdk); // No dependencies
  require('./URI.js')(MsrpSdk); // No dependencies
  require('./Util.js')(MsrpSdk); // No dependencies

  require('./ContentType.js')(MsrpSdk); // Depends on: Util
  require('./User.js')(MsrpSdk); // Depends on: URI

  require('./Sdp.js')(MsrpSdk); // Depends on: Content-Type, Util
  require('./Message.js')(MsrpSdk); // Depends on: Content-Type, Status, Util

  require('./Exceptions.js')(MsrpSdk);
  require('./ChunkReceiver.js')(MsrpSdk);
  require('./ChunkSender.js')(MsrpSdk); // Depends on: Message, Status, Util
  require('./Parser.js')(MsrpSdk); // Depends on: Message

  require('./Server.js')(MsrpSdk); // Depends on: Config, Message, SocketHandler
  require('./Session.js')(MsrpSdk); // Depends on: Config, Message, Sdp, SocketHandler, URI, Util

  require('./SessionController.js')(MsrpSdk); // Depends on: Session

  require('./SocketHandler.js')(MsrpSdk); // Depends on: Message, Parser, SessionController, Status, URI

  // TODO:
  // NOTE: There is a circular dependency
  // SessionController depends on Session.
  // Session depends on SocketHandler and SessionController.
  // SocketHandler depends on SessionController.

  return MsrpSdk;
};
