'use strict';

// eslint-disable-next-line max-lines-per-function
module.exports = function (MsrpSdk) {
  const Flag = {
    continued: '+',
    end: '$',
    abort: '#'
  };

  const OtherMimeHeaders = ['Content-ID', 'Content-Description', 'Content-Disposition'];

  /**
   * Parent class for all MSRP messages
   */
  class BaseMessage {
    constructor() {
      this.tid = null;
      this.toPath = [];
      this.fromPath = [];
      this.headers = new Map();
      this.continuationFlag = Flag.end;
    }

    _parseByteRange(value) {
      const rangeSepIndex = value.indexOf('-');
      const totalSepIndex = value.indexOf('/', rangeSepIndex);

      if (rangeSepIndex === -1 || totalSepIndex === -1) {
        MsrpSdk.Logger.warn(`Unexpected Byte-Range format: ${value}`);
        return false;
      }

      const range = {
        start: parseInt(value.substring(0, rangeSepIndex), 10),
        end: value.substring(rangeSepIndex + 1, totalSepIndex).trim(),
        total: value.substring(totalSepIndex + 1).trim()
      };
      range.end = range.end === '*' ? -1 : parseInt(range.end, 10);
      range.total = range.total === '*' ? -1 : parseInt(range.total, 10);

      if (isNaN(range.start) || isNaN(range.end) || isNaN(range.total)) {
        MsrpSdk.Logger.warn(`Unexpected Byte-Range values: ${value}`);
        return false;
      }

      this.byteRange = range;
      return true;
    }

    _updateHeader(name, value, replace = false) {
      name = MsrpSdk.Util.normaliseHeader(name);

      // Standard headers are stored in their own properties
      switch (name) {
        case 'To-Path':
          this.toPath = value.split(' ');
          break;
        case 'From-Path':
          this.fromPath = value.split(' ');
          break;
        case 'Byte-Range':
          return this._parseByteRange(value);
        case 'Content-Type':
          this.contentType = value;
          break;
        default:
          const values = replace ? null : this.headers.get(name);
          if (values) {
            values.push(value);
          } else {
            this.headers.set(name, [value]);
          }
          break;
      }
      return true;
    }

    addHeader(name, value) {
      return this._updateHeader(name, value, false);
    }

    setHeader(name, value) {
      return this._updateHeader(name, value, true);
    }

    deleteHeader(name) {
      this.headers.delete(name);
    }

    getHeader(name) {
      const values = this.headers.get(MsrpSdk.Util.normaliseHeader(name));
      if (values) {
        return values.length > 1 ? values : values[0];
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
      this.byteRange = null;
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
      let end = this.getEndLine();
      if (this.body && typeof this.body === 'string') {
        // If the body contains the end-line, change the transaction ID
        while (this.body.indexOf(end) !== -1) {
          this.tid = MsrpSdk.Util.newTID();
          end = this.getEndLine();
        }
      }

      let msg = `MSRP ${this.tid} ${this.method}\r\n\
To-Path: ${this.toPath.join(' ')}\r\n\
From-Path: ${this.fromPath.join(' ')}\r\n`;

      if (this.byteRange) {
        const r = this.byteRange;
        msg += `Byte-Range: ${r.start}-${r.end < 0 ? '*' : r.end}/${r.total < 0 ? '*' : r.total}\r\n`;
      }

      for (const [name, values] of this.headers) {
        if (!OtherMimeHeaders.includes(name)) {
          msg += `${name}: ${values.join(' ')}\r\n`;
        }
      }

      let type = this.contentType;
      if (type && this.body) {
        OtherMimeHeaders.forEach(name => {
          if (this.headers.has(name)) {
            msg += `${name}: ${this.headers.get(name).join(' ')}\r\n`;
          }
        });

        // Content-Type is the last header, and a blank line separates the headers from the message body.
        if (type instanceof MsrpSdk.ContentType) {
          type = type.toContentTypeHeader();
        }
        msg += `Content-Type: ${type}\r\n\r\n${this.body}\r\n${end}`;
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
      let msg = `MSRP ${this.tid} ${this.status}${this.comment ? ` ${this.comment}` : ''}\r\n\
To-Path: ${this.toPath.join(' ')}\r\n\
From-Path: ${this.fromPath.join(' ')}\r\n`;

      for (const [name, values] of this.headers) {
        msg += `${name}: ${values.join(' ')}\r\n`;
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
