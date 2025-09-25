# MSRP Node.js Library

[![CI/CD Pipeline](https://github.com/cwysong85/msrp-node-lib/workflows/CI/CD%20Pipeline/badge.svg)](https://github.com/cwysong85/msrp-node-lib/actions/workflows/ci.yml)
[![Test Coverage](https://codecov.io/gh/cwysong85/msrp-node-lib/branch/main/graph/badge.svg)](https://codecov.io/gh/cwysong85/msrp-node-lib)
[![npm version](https://badge.fury.io/js/msrp-node-lib.svg)](https://badge.fury.io/js/msrp-node-lib)
[![npm downloads](https://img.shields.io/npm/dm/msrp-node-lib.svg)](https://www.npmjs.com/package/msrp-node-lib)
[![Node.js Version](https://img.shields.io/node/v/msrp-node-lib)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

A complete MSRP (Message Session Relay Protocol) library for Node.js applications, supporting RFC 4975 message relay protocol with SDP integration.

## 🚀 Features

- ✅ **Complete RFC 4975 Implementation** - Full MSRP protocol support
- ✅ **SDP Integration** - Seamless session description handling
- ✅ **Multi-Process Testing** - Advanced test infrastructure with real network communication
- ✅ **Cross-Platform** - Works on Windows, macOS, and Linux
- ✅ **Production Ready** - Comprehensive error handling and resource management
- ✅ **TypeScript Ready** - Full type definitions included
- ✅ **High Test Coverage** - Extensive unit and functional tests

## Installation

```bash
npm install msrp-node-lib
```

## Quick Start

```javascript
const msrp = require("msrp-node-lib")({
  host: "127.0.0.1", // IP to bind server to
  port: 2855,
  sessionName: "user-a",
  acceptTypes: "text/plain",
  setup: "active",
  // advertiseHost: 'public.ip.address' // Optional: IP to advertise in SDP
});

// Start the MSRP server
msrp.Server.start((err) => {
  if (err) {
    console.error("Error starting MSRP service:", err);
    return;
  }
  console.log("MSRP Service started");

  // Create a session
  const session = msrp.SessionController.createSession();

  // Handle connection
  session.on("socketSet", (session) => {
    console.log("Connected! Ready to send messages");
    session.sendMessage("Hello World!");
  });

  // Handle incoming messages
  session.on("message", (message) => {
    console.log("Received:", message.body);
  });
});
```

## Configuration

The MSRP library accepts a configuration object with the following options:

### Required Configuration

| Option        | Type   | Description                                           |
| ------------- | ------ | ----------------------------------------------------- |
| `host`        | String | IP address or hostname for the MSRP server to bind to |
| `port`        | Number | Port number for the MSRP server                       |
| `sessionName` | String | Session name to use in SDP                            |
| `acceptTypes` | String | MIME types accepted (e.g., 'text/plain')              |
| `setup`       | String | Connection setup role: 'active' or 'passive'          |

### Optional Configuration

| Option                            | Type    | Default      | Description                                               |
| --------------------------------- | ------- | ------------ | --------------------------------------------------------- |
| `advertiseHost`                   | String  | `host` value | IP address/hostname to advertise in SDP and message paths |
| `traceMsrp`                       | Boolean | `false`      | Enable MSRP protocol tracing                              |
| `requestReports`                  | Boolean | `true`       | Request delivery reports for sent messages                |
| `forceSetup`                      | Boolean | `false`      | Force use of specified setup attribute                    |
| `enableHeartbeats`                | Boolean | `true`       | Enable heartbeat mechanism                                |
| `heartbeatsInterval`              | Number  | `5000`       | Heartbeat interval (ms)                                   |
| `heartbeatsTimeout`               | Number  | `10000`      | Heartbeat timeout (ms)                                    |
| `useInboundMessageForSocketSetup` | Boolean | `false`      | Use inbound messages for socket setup                     |
| `reuseOutboundPortOnReInvites`    | Boolean | `true`       | Reuse outbound port for re-invites                        |

### Timeout Configuration

| Option                   | Type   | Default | Description                             |
| ------------------------ | ------ | ------- | --------------------------------------- |
| `idleSocketTimeout`      | Number | `0`     | Socket idle timeout (ms, 0 = disabled)  |
| `socketConnectTimeout`   | Number | `0`     | Connection timeout (ms, 0 = disabled)   |
| `socketReconnectTimeout` | Number | `0`     | Reconnection timeout (ms, 0 = disabled) |
| `danglingSocketTimeout`  | Number | `20000` | Dangling socket cleanup timeout (ms)    |

### Port Range Configuration

| Option                | Type   | Default | Description                           |
| --------------------- | ------ | ------- | ------------------------------------- |
| `outboundBasePort`    | Number | `49152` | Starting port for dynamic connections |
| `outboundHighestPort` | Number | `65535` | Highest port for dynamic connections  |

### Host Configuration

The library supports separate binding and advertising addresses:

- **`host`** - The IP address the server binds to (where it listens)
- **`advertiseHost`** - The IP address advertised in SDP and MSRP message paths (where clients should connect)

#### Common Scenarios:

```javascript
// Scenario 1: Simple local setup
const msrp = require("msrp-node-lib")({
  host: "127.0.0.1",
  port: 2855,
  // advertiseHost defaults to '127.0.0.1'
});

// Scenario 2: Behind NAT/firewall
const msrp = require("msrp-node-lib")({
  host: "192.168.1.100", // Internal IP to bind to
  advertiseHost: "203.0.113.10", // Public IP to advertise
  port: 2855,
});

// Scenario 3: Listen on all interfaces
const msrp = require("msrp-node-lib")({
  host: "0.0.0.0", // Bind to all interfaces
  advertiseHost: "192.168.1.100", // Specific IP to advertise
  port: 2855,
});

// Scenario 4: Auto-detect advertise address
const msrp = require("msrp-node-lib")({
  host: "0.0.0.0", // Bind to all interfaces
  // advertiseHost not set - library will auto-detect reachable IP
  port: 2855,
});
```

**Note:** When `host` is set to `'0.0.0.0'` and `advertiseHost` is not specified, the library will automatically determine the best network interface IP address to advertise instead of using `'0.0.0.0'`.

### Custom Logger

You can provide a custom logger instead of using console:

```javascript
const winston = require("winston");

const msrp = require("msrp-node-lib")(
  {
    host: "127.0.0.1",
    port: 2855,
    sessionName: "user-a",
    acceptTypes: "text/plain",
    setup: "active",
  },
  winston.createLogger({
    level: "debug",
    format: winston.format.simple(),
    transports: [new winston.transports.Console()],
  })
);
```

## Events

All events are emitted by sessions and forwarded through the SessionController. You can listen to events on individual sessions or the SessionController itself.

### Event Categories

#### Session Events

- `update` - Session state updated
- `end` - Session ended

#### Message Events

- `message` - Incoming MSRP message received
- `messageSent` - Outgoing message sent successfully
- `response` - MSRP response received (for sent messages)
- `responseSent` - MSRP response sent (for received messages)
- `report` - Delivery report received
- `reportSent` - Delivery report sent

#### Connection Events

- `socketSet` - Socket connection established (ready to send messages)
- `socketClose` - Socket connection closed
- `socketError` - Socket error occurred

#### Timeout Events

- `socketConnectTimeout` - Socket connection timeout
- `idleSocketTimeout` - Socket idle timeout
- `socketReconnectTimeout` - Socket reconnection timeout

#### Heartbeat Events

- `heartbeatFailure` - Heartbeat mechanism failed
- `heartbeatTimeout` - Heartbeat response timeout

### Event Parameters

| Event                    | Parameters                             | Description                   |
| ------------------------ | -------------------------------------- | ----------------------------- |
| `message`                | `(message, session, encodedMessage)`   | Incoming MSRP message         |
| `messageSent`            | `(message, session, encodedMessage)`   | Outgoing message sent         |
| `response`               | `(response, session, encodedResponse)` | MSRP response received        |
| `responseSent`           | `(response, session, encodedResponse)` | MSRP response sent            |
| `report`                 | `(report, session, encodedReport)`     | Delivery report received      |
| `reportSent`             | `(report, session, encodedReport)`     | Delivery report sent          |
| `update`                 | `(session)`                            | Session state updated         |
| `end`                    | `(session)`                            | Session ended                 |
| `socketSet`              | `(session)`                            | Socket connection established |
| `socketClose`            | `(hadError, session)`                  | Socket connection closed      |
| `socketError`            | `(session)`                            | Socket error occurred         |
| `socketConnectTimeout`   | `(session)`                            | Socket connection timeout     |
| `idleSocketTimeout`      | `(session)`                            | Socket idle timeout           |
| `socketReconnectTimeout` | `(session)`                            | Socket reconnection timeout   |
| `heartbeatFailure`       | `(session)`                            | Heartbeat mechanism failed    |
| `heartbeatTimeout`       | `(session)`                            | Heartbeat response timeout    |

## Usage Examples

### Basic Session Usage

```javascript
const msrp = require("msrp-node-lib")({
  host: "127.0.0.1",
  port: 2855,
  sessionName: "user-a",
  acceptTypes: "text/plain",
  setup: "active",
});

// Start the server
msrp.Server.start((err) => {
  if (err) {
    console.error("Failed to start MSRP server:", err);
    return;
  }

  // Create a session
  const session = msrp.SessionController.createSession();

  // Set up event handlers
  session.on("socketSet", (session) => {
    console.log("Connected! Session ID:", session.sid);
    session.sendMessage("Hello World!");
  });

  session.on("message", (message, session) => {
    console.log("Received:", message.body);
    console.log("Content-Type:", message.contentType);
  });

  session.on("messageSent", (message, session) => {
    console.log("Message sent:", message.messageId);
  });

  session.on("socketClose", (hadError, session) => {
    console.log("Connection closed:", hadError ? "with error" : "normally");
  });
});
```

### SDP Integration

MSRP sessions work with SDP (Session Description Protocol) for connection setup:

```javascript
// Create a session for SIP call setup
const session = msrp.SessionController.createSession();

// Generate local SDP offer
const localSdp = session.getDescription();
console.log("Local SDP:", localSdp);

// When you receive remote SDP answer
const remoteSdp = `
v=0
o=user-b 789012 210987 IN IP4 192.168.1.100
s=user-b
c=IN IP4 192.168.1.100
t=0 0
m=message 2856 TCP/MSRP *
a=accept-types:text/plain
a=path:msrp://192.168.1.100:2856/session456;tcp
a=setup:passive
`;

try {
  session.setDescription(remoteSdp.trim());
  console.log("SDP negotiation complete");
} catch (error) {
  console.error("SDP error:", error);
}
```

### SDP Setup Attributes

- `setup:active` - This endpoint initiates the TCP connection
- `setup:passive` - This endpoint waits for incoming connections
- `setup:actpass` - This endpoint can be either active or passive

### Server Management

```javascript
// Start server
msrp.Server.start((err) => {
  if (err) console.error("Start error:", err);
  else console.log("Server started");
});

// Stop server
msrp.Server.stop(() => {
  console.log("Server stopped");
});

// Graceful shutdown
process.on("SIGINT", () => {
  msrp.Server.stop(() => process.exit(0));
});
```

## API Reference

### Session Methods

```javascript
const session = msrp.SessionController.createSession();

// Send a message
session.sendMessage("Hello World!", (error) => {
  if (error) console.error("Send failed:", error);
  else console.log("Message queued");
});

// Get local SDP description
const sdp = session.getDescription();

// Set remote SDP description
session.setDescription(remoteSdp);

// End the session
session.end();
```

### SessionController Methods

```javascript
// Create a new session
const session = msrp.SessionController.createSession();

// Get session by ID
const session = msrp.SessionController.getSession(sessionId);

// Get sessions by remote address
const sessions =
  msrp.SessionController.getSessionsByRemoteSocketAddress("192.168.1.100:2856");

// Remove a session
msrp.SessionController.removeSession(session);
```

### Server Methods

```javascript
// Start the server
msrp.Server.start((error) => {
  // Handle start result
});

// Stop the server
msrp.Server.stop(() => {
  // Handle stop completion
});
```

## License

This project is licensed under the MIT License.
