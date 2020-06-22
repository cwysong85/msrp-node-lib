/* eslint-disable no-console */
'use strict';

const MsrpSdk = {};

module.exports = function (config, logger) {
  config = config || {};

  MsrpSdk.Config = {
    acceptTypes: config.acceptTypes || 'text/plain',
    enableHeartbeats: !!config.enableHeartbeats,
    forwardSessionEvents: !!config.forwardSessionEvents,
    heartbeatsInterval: config.heartbeatsInterval || 5000,
    heartbeatsTimeout: config.heartbeatsTimeout || 10000,
    host: config.host || '127.0.0.1',
    isProduction: typeof config.isProduction === 'boolean' ? config.isProduction : process.env.NODE_ENV === 'production',
    manualReports: !!config.manualReports,
    obfuscateBody: !!config.obfuscateBody,
    offerInboundPortOnSdp: !!config.offerInboundPortOnSdp,
    outboundBasePort: config.outboundBasePort || 49152,
    outboundHighestPort: config.outboundHighestPort || 65535,
    port: config.port || 2855,
    sessionName: config.sessionName || '-',
    setup: config.setup === 'passive' ? 'passive' : 'active',
    signalingHost: config.signalingHost || config.host || '127.0.0.1',
    socketTimeout: config.socketTimeout || 0,
    traceMsrp: !!config.traceMsrp
  };

  if (MsrpSdk.Config.signalingHost !== MsrpSdk.Config.host) {
    // If we are using a different signaling address then always use listening port (i.e., inbound port) on SDP.
    MsrpSdk.Config.offerInboundPortOnSdp = true;
  }

  MsrpSdk.Config.outboundHighestPort = Math.max(MsrpSdk.Config.outboundBasePort, MsrpSdk.Config.outboundHighestPort);

  MsrpSdk.Logger = logger || {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  };

  if (!MsrpSdk.Logger.warn) {
    if (typeof MsrpSdk.Logger.warning === 'function') {
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

  require('./SessionController.js')(MsrpSdk);
  require('./SocketHandler.js')(MsrpSdk); // Depends on: Message, Parser, SessionController, Status, URI
  require('./Session.js')(MsrpSdk); // Depends on: Config, Message, Sdp, SessionController, SocketHandler, URI, Util

  require('./Server.js')(MsrpSdk); // Depends on: Config, Message, SocketHandler

  return MsrpSdk;
};
