/* eslint-disable no-console */
'use strict';

const MsrpSdk = {};

module.exports = function (config, logger) {
  config = config || {};

  const DEFAULT_HEARTBEAT_INTERVAL = 60;
  const DEFAULT_HEARTBEAT_TIMEOUT = 5;
  const MIN_HEARTBEAT_INTERVAL = 10;
  const MIN_HEARTBEAT_TIMEOUT = 1;

  MsrpSdk.Config = {
    acceptTypes: config.acceptTypes || 'text/plain',
    enableHeartbeats: !!config.enableHeartbeats,
    forwardSessionEvents: !!config.forwardSessionEvents,
    heartbeatInterval: Math.max(Math.floor(config.heartbeatInterval) || DEFAULT_HEARTBEAT_INTERVAL, MIN_HEARTBEAT_INTERVAL),
    heartbeatTimeout: Math.max(Math.floor(config.heartbeatTimeout) || DEFAULT_HEARTBEAT_TIMEOUT, MIN_HEARTBEAT_TIMEOUT),
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

  if (logger) {
    const logDebug = logger.debug || logger.log || function () {};
    const logInfo = logger.info || logDebug;
    const logWarn = logger.warn || logger.warning || logInfo;
    const logError = logger.error || logWarn;

    MsrpSdk.Logger = {
      debug: logDebug.bind(logger),
      info: logInfo.bind(logger),
      warn: logWarn.bind(logger),
      error: logError.bind(logger)
    };

    MsrpSdk.Logger.info('Start MSRP library with config:', MsrpSdk.Config);

  } else {
    MsrpSdk.Logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {}
    };
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
