module.exports = function(MsrpSdk) {
  var lineEnd = '\r\n';

  /**
   * Encapsulates all of the MSRP message classes.
   * @namespace Message
   * @private
   */
  var Message = {};

  Message.Flag = {
    continued: '+',
    end: '$',
    abort: '#'
  };

  /**
   * Parent class for all MSRP messages
   * @class
   * @private
   */
  Message.Message = function() {};
  Message.Message.prototype.initMessage = function() {
    this.tid = null;
    this.toPath = [];
    this.fromPath = [];
    this.headers = {};
    this.continuationFlag = MsrpSdk.Message.Flag.end;
  };
  Message.Message.prototype.addHeader = function(name, value) {
    name = MsrpSdk.Util.normaliseHeader(name);

    // Standard headers are stored in their own properties
    switch (name) {
      case 'To-Path':
        this.toPath = value.split(' ');
        return;
      case 'From-Path':
        this.fromPath = value.split(' ');
        return;
      case 'Content-Type':
        this.contentType = value;
        return;
      default:
        break;
    }

    if (this.headers[name]) {
      this.headers[name].push(value);
    } else {
      this.headers[name] = [value];
    }
  };
  Message.Message.prototype.getHeader = function(name) {
    name = MsrpSdk.Util.normaliseHeader(name);
    if (name in this.headers) {
      if (this.headers[name].length > 1) {
        return this.headers[name];
      }
      return this.headers[name][0];
    }
    return null;
  };
  Message.Message.prototype.getEndLineNoFlag = function() {
    return '-------' + this.tid;
  };
  Message.Message.prototype.getEndLine = function() {
    return this.getEndLineNoFlag().concat(this.continuationFlag, lineEnd);
  };

  /**
   * Creates a new Request object.
   * @class Parent class for all MSRP requests.
   * @extends CrocMSRP.Message.Message
   * @private
   */
  Message.Request = function() {};
  Message.Request.prototype = new Message.Message();
  Message.Request.prototype.constructor = Message.Request;
  Message.Request.prototype.initRequest = function() {
    this.initMessage();
    this.method = null;
    this.contentType = null;
    this.body = null;
  };
  Message.Request.prototype.addBody = function(type, body) {
    this.contentType = type;
    this.body = body;
  };
  Message.Request.prototype.addTextBody = function(text) {
    this.addBody('text/plain', text);
  };

  /**
   * Creates a new Response object.
   * @class Parent class for all MSRP responses.
   * @extends CrocMSRP.Message.Message
   * @private
   */
  Message.Response = function() {};
  Message.Response.prototype = new Message.Message();
  Message.Response.prototype.constructor = Message.Response;
  Message.Response.prototype.initResponse = function() {
    this.initMessage();
    this.status = null;
    this.comment = null;
  };

  /**
   * Creates a new outgoing MSRP request.
   * @class Class representing an outgoing MSRP request.
   * @extends CrocMSRP.Message.Request
   * @private
   */
  Message.OutgoingRequest = function(session, method) {
    if (!session || !method) {
      throw new TypeError('Required parameter is missing');
    }

    this.initRequest();
    
    this.tid = this.tid === null ? MsrpSdk.Util.newTID() : this.tid; 
    this.method = method;

    this.toPath = session.toPath;
    this.fromPath = [session.localUri];
    this.session = session;

    this.byteRange = null;
  };
  Message.OutgoingRequest.prototype = new Message.Request();
  Message.OutgoingRequest.prototype.constructor = Message.OutgoingRequest;
  Message.OutgoingRequest.prototype.encode = function() {
    var msg = '',
      name, type = this.contentType,
      end = this.getEndLine();

    if (this.body && (this.body instanceof String || typeof this.body === 'string')) {
      // If the body contains the end-line, change the transaction ID
      while (this.body.indexOf(end) !== -1) {
        this.tid = MsrpSdk.Util.newTID();
        end = this.getEndLine();
      }
    }

    msg = msg.concat('MSRP ', this.tid, ' ', this.method, lineEnd);
    msg = msg.concat('To-Path: ', this.toPath.join(' '), lineEnd);
    msg = msg.concat('From-Path: ', this.fromPath.join(' '), lineEnd);

    if (this.byteRange) {
      var r = this.byteRange,
        total = (r.total < 0 ? '*' : r.total);
      this.addHeader('byte-range', r.start + '-' + r.end + '/' + total);
    }

    for (name in this.headers) {
      msg = msg.concat(name, ': ', this.headers[name].join(' '), lineEnd);
    }

    if (type && this.body) {
      // Content-Type is the last header, and a blank line separates the
      // headers from the message body.
      if (type instanceof MsrpSdk.ContentType) {
        type = type.toContentTypeHeader();
      }
      msg = msg.concat('Content-Type: ', type, lineEnd, lineEnd);

      if (this.body instanceof String || typeof this.body === 'string') {
        msg = msg.concat(this.body, lineEnd, end);
      } else {
        // Turn the entire message into a blob, encapsulating the body
        msg = new Blob([msg, this.body, lineEnd, end]);
      }
    } else {
      msg += end;
    }

    return msg;
  };

  /**
   * Creates a new incoming MSRP request.
   * @class Class representing an incoming MSRP request.
   * @extends CrocMSRP.Message.Request
   * @private
   */
  Message.IncomingRequest = function(tid, method) {
    if (!tid || !method) {
      return null;
    }

    this.initRequest();
    this.tid = tid;
    this.method = method;

    switch (method) {
      case 'SEND':
        // Start by assuming responses are required
        // Can be overriden by request headers
        this.responseOn = {
          success: true,
          failure: true
        };
        break;
      case 'REPORT':
        // Never send responses
        this.responseOn = {
          success: false,
          failure: false
        };
        break;
    }

    this.byteRange = {
      start: 1,
      end: -1,
      total: -1
    };
  };
  Message.IncomingRequest.prototype = new Message.Request();
  Message.IncomingRequest.prototype.constructor = Message.IncomingRequest;

  /**
   * Creates a new outgoing MSRP response.
   * @class Class representing an outgoing MSRP response.
   * @extends CrocMSRP.Message.Response
   * @private
   */
  Message.OutgoingResponse = function(request, localUri, status) {
    if (!request || !localUri) {
      return null;
    }

    this.initResponse();
    this.tid = request.tid;
    this.status = status || MsrpSdk.Status.OK;
    this.comment = MsrpSdk.StatusComment[this.status];

    if (request.method === 'SEND') {
      // Response is only sent to the previous hop
      this.toPath = request.fromPath.slice(0, 1);
    } else {
      this.toPath = request.fromPath;
    }
    this.fromPath = [localUri.toString()];
  };
  Message.OutgoingResponse.prototype = new Message.Response();
  Message.OutgoingResponse.prototype.constructor = Message.OutgoingResponse;
  Message.OutgoingResponse.prototype.encode = function() {
    var msg = '',
      name;

    msg = msg.concat('MSRP ', this.tid, ' ', this.status);
    if (this.comment) {
      msg = msg.concat(' ', this.comment);
    }
    msg += lineEnd;

    msg = msg.concat('To-Path: ', this.toPath.join(' '), lineEnd);
    msg = msg.concat('From-Path: ', this.fromPath.join(' '), lineEnd);

    for (name in this.headers) {
      msg = msg.concat(name, ': ', this.headers[name].join(' '), lineEnd);
    }

    return msg + this.getEndLine();
  };

  /**
   * Creates a new incoming MSRP response.
   * @class Class representing an incoming MSRP response.
   * @extends CrocMSRP.Message.Response
   * @private
   */
  Message.IncomingResponse = function(tid, status, comment) {
    if (!tid || !status) {
      return null;
    }

    this.initResponse();
    this.tid = tid;
    this.status = status;
    this.comment = comment;
    this.request = null;
    this.authenticate = [];
  };
  Message.IncomingResponse.prototype = new Message.Response();
  Message.IncomingResponse.prototype.constructor = Message.IncomingResponse;

  MsrpSdk.Message = Message;
};
