'use strict';

// eslint-disable-next-line max-lines-per-function
module.exports = function (MsrpSdk) {
  const lineEnd = '\r\n';

  const Flag = {
    continued: '+',
    end: '$',
    abort: '#'
  };

  /**
   * Parent class for all MSRP messages
   */
  class BaseMessage {
    constructor() {
      this.tid = null;
      this.toPath = [];
      this.fromPath = [];
      this.headers = {};
      this.continuationFlag = Flag.end;
    }

    addHeader(name, value) {
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
    }

    getHeader(name) {
      const header = this.headers[MsrpSdk.Util.normaliseHeader(name)];
      if (header) {
        return header.length > 1 ? header : header[0];
      }
      return null;
    }

    getEndLineNoFlag() {
      return `-------${this.tid}`;
    }

    getEndLine() {
      return `-------${this.tid}${this.continuationFlag}\r\n`;
    }
  }

  /**
   * Parent class for all MSRP requests.
   */
  class Request extends BaseMessage {
    constructor(method) {
      if (!method) {
        throw new TypeError('Required parameter is missing');
      }
      super();
      this.method = method;
      this.contentType = null;
      this.body = null;
    }

    addBody(type, body) {
      this.contentType = type;
      this.body = body;
    }

    addTextBody(text) {
      this.addBody('text/plain', text);
    }

    isComplete() {
      return (!this.byteRange || this.byteRange.start === 1) && this.continuationFlag === Flag.end;
    }
  }

  /**
   * Class representing an outgoing MSRP request.
   */
  class OutgoingRequest extends Request {
    constructor(routePaths, method, tid = null) {
      if (!routePaths) {
        throw new TypeError('Required parameter is missing');
      }
      super(method);
      this.tid = tid || MsrpSdk.Util.newTID();
      this.toPath = routePaths.toPath;
      this.fromPath = routePaths.fromPath;
      this.byteRange = null;
    }

    encode() {
      let msg = '',
        name,
        type = this.contentType,
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
        const r = this.byteRange;
        this.addHeader('byte-range', `${r.start}-${r.end < 0 ? '*' : r.end}/${r.total < 0 ? '*' : r.total}`);
      }

      for (name in this.headers) {
        if (this.headers.hasOwnProperty(name)) {
          msg = msg.concat(name, ': ', this.headers[name].join(' '), lineEnd);
        }
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
          msg = msg.concat(this.body.toString(), lineEnd, end);
        }
      } else {
        msg += end;
      }

      return msg;
    }
  }

  /**
   * Class representing an incoming MSRP request.
   */
  class IncomingRequest extends Request {
    constructor(tid, method) {
      if (!tid) {
        throw new TypeError('Required parameter is missing');
      }
      super(method);
      this.tid = tid;

      if (method === 'REPORT') {
        // Never send responses
        this.responseOn = {
          success: false,
          failure: false
        };
      } else {
        // Start by assuming responses are required. Can be overriden by "Failure-Report" request headers.
        this.responseOn = {
          success: true,
          failure: true
        };
      }

      this.byteRange = {
        start: 1,
        end: -1,
        total: -1
      };
    }
  }

  /**
   * Parent class for all MSRP responses.
   */
  class Response extends BaseMessage {
    constructor() {
      super();
      this.status = null;
      this.comment = null;
    }
  }

  /**
   * Class representing an outgoing MSRP response.
   */
  class OutgoingResponse extends Response {
    constructor(request, localUri, status, comment = null) {
      if (!request || !localUri) {
        throw new TypeError('Required parameter is missing');
      }
      super();

      this.tid = request.tid;
      this.status = status || MsrpSdk.Status.OK;
      this.comment = comment || MsrpSdk.StatusComment[this.status];

      if (request.method === 'SEND') {
        // Response is only sent to the previous hop
        this.toPath = request.fromPath.slice(0, 1);
      } else {
        this.toPath = request.fromPath;
      }
      this.fromPath = [localUri.toString()];
    }

    encode() {
      let msg = '',
        name;

      msg = msg.concat('MSRP ', this.tid, ' ', this.status);
      if (this.comment) {
        msg = msg.concat(' ', this.comment);
      }
      msg += lineEnd;

      msg = msg.concat('To-Path: ', this.toPath.join(' '), lineEnd);
      msg = msg.concat('From-Path: ', this.fromPath.join(' '), lineEnd);

      for (name in this.headers) {
        if (this.headers.hasOwnProperty(name)) {
          msg = msg.concat(name, ': ', this.headers[name].join(' '), lineEnd);
        }
      }

      return msg + this.getEndLine();
    }
  }

  /**
   * Class representing an incoming MSRP response.
   */
  class IncomingResponse extends Response {
    constructor(tid, status, comment = '') {
      if (!tid || !status) {
        throw new TypeError('Required parameter is missing');
      }
      super();

      this.tid = tid;
      this.status = status;
      this.comment = comment;
      this.request = null;
      this.authenticate = [];
    }
  }

  MsrpSdk.Message = {
    Flag,
    Request,
    OutgoingRequest,
    IncomingRequest,
    Response,
    OutgoingResponse,
    IncomingResponse
  };
};
