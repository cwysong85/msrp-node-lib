# A MSRP library for NodeJS applications

### Initialization

Create the MSRP library with minimal settings:
```
const msrp = require('msrp-node-lib')({
    host: '127.0.0.1',
    port: 2855,
    traceMsrp: true,
    sessionName: 'user-a',
    acceptTypes: 'text/plain',
    setup: 'active'
});
```

You can also pass a custom `logger` to the MSRP library, otherwise the `console` logging methods are used. Here is an example of passing the custom logger to the MSRP library:
```
const winston = require('winston');

const msrp = require('msrp-node-lib')(
{
    host: '127.0.0.1',
    port: 2855,
    traceMsrp: true,
    sessionName: 'user-a',
    acceptTypes: 'text/plain',
    setup: 'active'
}, new(winston.Logger)({
    levels: {
        debug: 0,
        info: 1,
        warning: 2,
        error: 3
    }
}));
```


Start MSRP server:
```
// Create msrp server
const msrpServer = new msrp.Server();

// Start server
msrpServer.start();
```

### Sessions

Create new session:
```
// Create session
const session = new msrp.Session();

// Register event handlers for session
session.on('socketSet', () => {
    console.log(`Socket connected for ${session.sid}`);
});

session.on('socketClose', () => {
    console.log(`Socket closed for ${session.sid}`);
});

session.on('socketError', () => {
    console.log(`Socket error for ${session.sid}`);
});

session.on('message', () => {
    console.log(`Message received for ${session.sid}`);
});

session.on('end', () => {
    console.log(`Session ${session.sid} has ended`);
});
```

Create SDP Answer from a given SDP Offer:
```
session.setDescription(sdpOffer, () => {
    console.log('Successfully set the remote SDP offer. Now get the SDP answer.');
    session.getDescription(sdpAnswer => {
        console.log(`Created local SDP answer: ${sdpAnswer}`);
        ...
    }, err => {
        console.error(`Failed to get local SDP answer. ${err}`);
    });
}, err => {
    logger.error(`Failed to set remote SDP offer. ${err}`);
});
```

Create SDP Offer:
```
session.getDescription(sdpOffer => {
    console.log(`Created local SDP offer: ${sdpOffer}`);
    ...
}, err => {
    console.error(`Failed to get local SDP offer. ${err}`);
});
```

Send message:
```
session.sendMessage('Hello World!', 'text/plain',
    messageId => {
        // onMessageSent callback - This is invoked after all message chunks are sent
        logger.debug(`Message sent with messageId ${messageId}`);
    },
    (status, messageId) => {
        // onReportReceived callback
        logger.debug(`Received report with status ${status} for messageId ${messageId}`);
    });

```
