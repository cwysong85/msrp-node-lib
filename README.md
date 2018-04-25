# A MSRP library for NodeJS applications

### Initialization

Create the MSRP library with minimal settings:
```
var MsrpSdk = require('msrp-node-lib')({
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
var winston = require('winston');
var Logger = new(winston.Logger)({
  levels: {
    debug: 0,
    info: 1,
    warning: 2,
    error: 3
  }
});

var MsrpSdk = require('msrp-node-lib')({
    host: '127.0.0.1',
    port: 2855,
    traceMsrp: true,
    sessionName: 'user-a',
    acceptTypes: 'text/plain',
    setup: 'active'
}, Logger);
```


Start MSRP server:
```
// create msrp server
var msrpServer = new MsrpSdk.Server();

// start server
msrpServer.start();
```

### Events

Socket connected event and MSRP session events:
```
msrpServer.on('socketConnect', function(session) {
    console.log('MSRP socket connected!');
    
    // create a session
    var msrpSession = MsrpSdk.SessionController.createSession();

    // send a message from this session
    msrpSession.sendMessage('Hello world!', function() {
    	console.log('Message sent!');
    });

    // receive a message for this session
    msrpSession.on('message', function(msg) {
    	console.log('Body: ' + msg.body)
    });

});
```


Other useful socket events:
```
msrpServer.on('socketTimeout', function() {
	console.log('MSRP socket timed out');
});

msrpServer.on('socketError', function() {
	console.log('MSRP socket error');
});

msrpServer.on('socketClose', function() {
	console.log('MSRP socket closed');
});

msrpServer.on('socketEnd', function() {
	console.log('MSRP socket ended');
});
 ```

