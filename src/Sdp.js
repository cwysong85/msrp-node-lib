'use strict';

// eslint-disable-next-line max-lines-per-function
module.exports = function (MsrpSdk) {
  const lineEnd = '\r\n';

  const CONNECTION_MODES = ['sendrecv', 'sendonly', 'recvonly', 'inactive'];

  // Helper function
  function getConnectionMode(obj) {
    if (!obj || !obj.attributes) {
      return null;
    }
    const attr = obj.attributes.find(a => CONNECTION_MODES.includes(a.name));
    return attr ? attr.name : null;
  }

  class SdpOrigin {
    constructor(origin) {
      if (origin) {
        if (!this.parse(origin)) {
          // Parse the provided origin line
          throw new Error('Cannot parse SDP o-line');
        }
      } else {
        // Set some sensible defaults
        this.reset();
      }
    }

    reset() {
      this.username = '-';
      this.id = MsrpSdk.Util.dateToNtpTime();
      this.version = this.id;
      this.netType = 'IN';
      this.addrType = 'IP4';
      this.address = 'address.invalid';
    }

    parse(origin) {
      const split = origin.split(' ');
      if (split.length !== 6) {
        MsrpSdk.Logger.warn(`[SDP]: Unexpected origin line: ${origin}`);
        return false;
      }

      this.username = split[0];
      this.id = split[1];
      this.version = split[2];
      this.netType = split[3];
      this.addrType = split[4];
      this.address = split[5];
      return true;
    }

    toString() {
      return `${this.username} ${this.id} ${this.version} ${this.netType} ${this.addrType} ${this.address}`;
    }
  }

  class SdpConnection {
    constructor(conn) {
      if (conn) {
        // Parse the provided connection line
        if (!this.parse(conn)) {
          throw new Error('Cannot parse SDP c-line');
        }
      } else {
        // Set some sensible defaults
        this.reset();
      }
    }

    reset() {
      this.netType = 'IN';
      this.addrType = 'IP4';
      this.address = null;
    }

    parse(conn) {
      const split = conn.split(' ');
      if (split.length !== 3) {
        MsrpSdk.Logger.warn(`[SDP]: Unexpected connection line: ${conn}`);
        return false;
      }

      this.netType = split[0];
      this.addrType = split[1];
      this.address = split[2];
      return true;
    }

    toString() {
      return `${this.netType} ${this.addrType} ${this.address || 'address.invalid'}`;
    }

    isEqual(conn) {
      return this.netType === conn.netType && this.addrType === conn.addrType && this.address === conn.address;
    }
  }

  class SdpTiming {
    constructor(timing) {
      if (timing) {
        // Parse the provided timing line
        if (!this.parse(timing)) {
          throw new Error('Cannot parse SDP t-line');
        }
      } else {
        // Set some sensible defaults
        this.reset();
      }
    }

    _getDate(time) {
      return time === '0' ? null : MsrpSdk.Util.ntpTimeToDate(time);
    }

    _getTime(date) {
      return date ? MsrpSdk.Util.dateToNtpTime(date) : '0';
    }

    reset() {
      this.start = null;
      this.stop = null;
      this.repeat = [];
    }

    // Parse expects to be passed the full t-line, plus any following r-lines
    parse(timing) {
      const lines = timing.split(lineEnd);
      const tLine = lines.shift();
      const tokens = tLine.split(' ');
      if (tokens.length !== 2) {
        MsrpSdk.Logger.warn(`[SDP]: Unexpected timing line: ${tLine}`);
        return false;
      }

      this.start = this._getDate(tokens[0]);
      this.stop = this._getDate(tokens[1]);

      // Don't care about repeat lines at the moment
      this.repeat = lines;

      return true;
    }

    toString() {
      let t = `${this._getTime(this.start)} ${this._getTime(this.stop)}`;
      this.repeat.forEach(line => {
        t += `\r\n${line}`;
      });
      return t;
    }
  }

  class AttributesContainer {
    constructor() {
      this.attributes = [];
    }

    addAttribute(name, value) {
      this.attributes.push({ name, value });
    }

    parseAttribute(line) {
      if (!line) {
        return null;
      }
      let name, value;
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {
        name = line;
        value = null;
      } else {
        name = line.substr(0, colonIndex);
        value = line.substr(colonIndex + 1);
      }
      this.addAttribute(name, value);
      return { name, value };
    }

    setAttribute(name, value) {
      const idx = this.attributes.findIndex(attr => attr.name === name);
      if (idx === -1) {
        // Add attribute
        this.attributes.push({ name, value });
      } else {
        // Update existing attribute
        this.attributes[idx].value = value;
      }
    }

    getAttributeValue(name) {
      const attribute = this.attributes.find(attr => attr.name === name);
      return attribute && attribute.value;
    }

    hasAttribute(name) {
      return this.attributes.some(attr => attr.name === name);
    }
  }

  class SdpMedia extends AttributesContainer {
    constructor(media) {
      super();

      if (media) {
        // Parse the provided media line
        if (!this.parse(media)) {
          throw new Error('Cannot parse SDP m-line');
        }
      } else {
        // Set some sensible defaults
        this.reset();
      }
    }

    reset() {
      this.media = 'message';
      this.port = 2855;
      this.portnum = 1;
      this.proto = 'TCP/MSRP';
      this.format = '*';

      this.info = null;
      this.connection = new SdpConnection();
      this.bandwidth = [];
      this.key = null;
      this.attributes = [];
    }

    isMsrp() {
      return this.media === 'message' && !!this.port &&
          (this.proto === 'TCP/MSRP' || this.proto === 'TCP/TLS/MSRP') && this.format === '*';
    }

    parse(media) {
      this.reset();

      const lines = media.split(lineEnd);
      const mLine = lines.shift();

      // RFC-4566
      // m=<media> <port> <proto> <fmt> ...
      // m=<media> <port>/<number of ports> <proto> <fmt> ...
      //
      // ABNF definition
      // %x6d "=" media SP port ["/" integer] SP proto 1*(SP fmt) CRLF
      //
      // media =  token
      //          ;typically "audio", "video", "text", or "application"
      //
      // fmt =    token
      //          ;typically an RTP payload type for audio and video media
      //
      // proto  = token *("/" token)
      //          ;typically "RTP/AVP" or "udp"
      //
      // port =   1*DIGIT
      //
      const reM = /^(\w+) +(\d+)(?:\/(\d))? +(\S+)(?: +(\S+(?: +\S+)*))?/;
      const tmp = reM.exec(mLine);
      if (!tmp) {
        MsrpSdk.Logger.warn(`[SDP]: Unexpected media line: ${mLine}`);
        return false;
      }

      this.media = tmp[1];
      this.port = +tmp[2];
      this.portnum = +(tmp[3] || 1);
      this.proto = tmp[4];
      this.format = tmp[5];

      lines.forEach(line => {
        if (!line || line === lineEnd) {
          MsrpSdk.Logger.warn('[SDP]: Unexpected empty line in SDP (within media)');
          return;
        }
        const value = line.slice(2);
        switch (line.substr(0, 2)) {
          case 'i=':
            this.info = value;
            break;
          case 'c=':
            this.connection = new SdpConnection(value);
            break;
          case 'b=':
            this.bandwidth.push(value);
            break;
          case 'k=':
            this.key = value;
            break;
          case 'a=':
            this.parseAttribute(value);
            break;
          default:
            MsrpSdk.Logger.warn(`[SDP]: Unexpected type (within media): ${line}`);
            break;
        }
      });
      return true;
    }

    toString() {
      let m = `${this.media} ${this.port} ${this.proto} ${this.format}`;

      if (this.info) {
        m += `\r\ni=${this.info}`;
      }
      if (this.connection && this.connection.address) {
        m += `\r\nc=${this.connection}`;
      }
      this.bandwidth.forEach(bw => {
        m += `\r\nb=${bw}`;
      });
      if (this.key) {
        m += `\r\nk=${this.key}`;
      }
      this.attributes.forEach(attr => {
        const aValue = attr.value === 0 ? '0' : attr.value;
        m += `\r\na=${attr.name}${aValue ? `:${aValue}` : ''}`;
      });

      return m;
    }
  }

  class Sdp extends AttributesContainer {
    constructor(sdp) {
      super();

      if (sdp) {
        // Parse the provided SDP
        if (!this.parse(sdp)) {
          throw new Error('Failed to parse SDP');
        }
      } else {
        // Set some sensible defaults
        this.reset();
      }
    }

    reset() {
      this.version = 0;
      this.origin = new SdpOrigin();
      this.sessionName = ' ';
      this.sessionInfo = null;
      this.uri = null;
      this.email = null;
      this.phone = null;
      this.connection = new SdpConnection();
      this.bandwidth = [];
      this.timing = [new SdpTiming()];
      this.timezone = null;
      this.key = null;
      this.attributes = [];
      this.media = [];
    }

    hasMsrp() {
      return this.media.some(m => m.isMsrp());
    }

    getMsrpMedia() {
      return this.media.find(m => m.isMsrp());
    }

    getMsrpMediaIndex() {
      return this.media.findIndex(m => m.isMsrp());
    }

    getConnectionMode(index = 0) {
      if (!this.media[index]) {
        return null;
      }
      // Check media attributes then session attributes. Default when not set is sendrecv.
      return getConnectionMode(this.media[index]) || getConnectionMode(this) || 'sendrecv';
    }

    getMsrpConnectionMode() {
      const mIndex = this.getMsrpMediaIndex();
      return mIndex === -1 ? 'inactive' : this.getConnectionMode(mIndex);
    }

    getMsrpConnection() {
      const media = this.getMsrpMedia();
      if (media && media.connection && media.connection.address) {
        return media.connection;
      }
      if (this.connection && this.connection.address) {
        return this.connection;
      }
      return null;
    }

    // eslint-disable-next-line complexity
    parse(sdp) {
      let line, value;

      const lines = sdp.split(lineEnd);
      if (lines[lines.length - 1] === '') {
        // SDP ends in CRLF; Remove last array element
        lines.pop();
      }

      this.reset();

      // SDP Syntax per RFC-4566
      // session-description = proto-version
      //                       origin-field
      //                       session-name-field
      //                       information-field [OPTIONAL]
      //                       uri-field [OPTIONAL]
      //                       email-fields [OPTIONAL]
      //                       phone-fields [OPTIONAL]
      //                       connection-field [OPTIONAL]
      //                       bandwidth-fields [OPTIONAL]
      //                       time-fields
      //                       key-field [OPTIONAL]
      //                       attribute-fields [OPTIONAL]
      //                       media-descriptions [OPTIONAL]

      if (lines.length < 4) {
        MsrpSdk.Logger.warn(`[SDP]: Unexpected SDP length: ${lines.length}`);
        return false;
      }

      line = lines.shift();
      if (line !== 'v=0') {
        MsrpSdk.Logger.warn(`[SDP]: Unexpected SDP version: ${line}`);
        return false;
      }

      line = lines.shift();
      if (line.indexOf('o=') === 0) {
        this.origin = new SdpOrigin(line.slice(2));
      } else {
        MsrpSdk.Logger.warn(`[SDP]: Unexpected SDP origin: ${line}`);
        return false;
      }

      line = lines.shift();
      if (line.indexOf('s=') === 0) {
        this.sessionName = line.slice(2);
      } else {
        MsrpSdk.Logger.warn(`[SDP]: Unexpected SDP session name: ${line}`);
        return false;
      }

      // Process any other optional pre-timing lines
      while (lines.length > 0 && lines[0].charAt(0) !== 't') {
        line = lines.shift();
        value = line.slice(2);

        switch (line.substr(0, 2)) {
          case 'i=':
            this.sessionInfo = value;
            break;
          case 'u=':
            this.uri = value;
            break;
          case 'e=':
            this.email = value;
            break;
          case 'p=':
            this.phone = value;
            break;
          case 'c=':
            this.connection = new SdpConnection(value);
            break;
          case 'b=':
            this.bandwidth.push(value);
            break;
          default:
            MsrpSdk.Logger.warn(`[SDP]: Unexpected SDP line (pre-timing): ${line}`);
            return false;
        }
      }

      if (lines.length === 0) {
        MsrpSdk.Logger.warn('[SDP]: Unexpected end of SDP (pre-timing)');
        return false;
      }

      this.timing = [];
      while (lines.length > 0 && lines[0].charAt(0) === 't') {
        line = lines.shift().slice(2);
        // Append any following r-lines
        while (lines.length > 0 && lines[0].charAt(0) === 'r') {
          line += `\r\n${lines.shift()}`;
        }

        this.timing.push(new SdpTiming(line));
      }

      if (this.timing.length === 0) {
        MsrpSdk.Logger.warn('[SDP]: No timing line found');
        return false;
      }

      // Process any optional pre-media lines
      while (lines.length > 0 && lines[0].charAt(0) !== 'm') {
        line = lines.shift();
        value = line.slice(2);

        switch (line.substr(0, 2)) {
          case 'z=':
            this.timezone = value;
            break;
          case 'k=':
            this.key = value;
            break;
          case 'a=':
            this.parseAttribute(value);
            break;
          default:
            MsrpSdk.Logger.warn(`[SDP]: Unexpected SDP line (pre-media): ${line}`);
            return false;
        }
      }

      while (lines.length > 0 && lines[0].charAt(0) === 'm') {
        line = lines.shift().slice(2);
        // Append any following lines up to the next m-line
        while (lines.length > 0 && lines[0].charAt(0) !== 'm') {
          line += `\r\n${lines.shift()}`;
        }

        this.media.push(new SdpMedia(line));
      }

      return true;
    }

    toString() {
      let sdp = `v=${this.version}\r\no=${this.origin}\r\ns=${this.sessionName}\r\n`;
      if (this.sessionInfo) {
        sdp += `i=${this.sessionInfo}\r\n`;
      }
      if (this.uri) {
        sdp += `u=${this.uri}\r\n`;
      }
      if (this.email) {
        sdp += `e=${this.email}\r\n`;
      }
      if (this.phone) {
        sdp += `p=${this.phone}\r\n`;
      }
      if (this.connection && this.connection.address) {
        sdp += `c=${this.connection}\r\n`;
      }
      this.bandwidth.forEach(bw => {
        sdp += `b=${bw}\r\n`;
      });
      this.timing.forEach(timing => {
        sdp += `t=${timing}\r\n`;
      });
      if (this.timezone) {
        sdp += `z=${this.timezone}\r\n`;
      }
      if (this.key) {
        sdp += `k=${this.key}\r\n`;
      }
      this.attributes.forEach(attr => {
        const aValue = attr.value === 0 ? '0' : attr.value;
        sdp += `a=${attr.name}${aValue ? `:${aValue}` : ''}\r\n`;
      });
      this.media.forEach(m => {
        sdp += `m=${m}\r\n`;
      });

      return sdp;
    }
  }

  MsrpSdk.SdpMedia = SdpMedia;
  MsrpSdk.Sdp = Sdp;
};
