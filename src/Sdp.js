'use strict';

// eslint-disable-next-line max-lines-per-function
module.exports = function (MsrpSdk) {
  const lineEnd = '\r\n';

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
      this.version = this.sessId;
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
      let o = '';

      o += `${this.username} `;
      o += `${this.id} `;
      o += `${this.version} `;
      o += `${this.netType} `;
      o += `${this.addrType} `;
      o += this.address;

      return o;
    }
  }

  class SdpConnection {
    constructor(conn) {
      if (conn) {
        // Parse the provided connection line
        if (!this.parse(conn)) {
          throw new Error('Call parse SDP c-line');
        }
      } else {
        // Set some sensible defaults
        this.reset();
      }
    }

    reset() {
      this.netType = 'IN';
      this.addrType = 'IP4';
      this.address = 'address.invalid';
    }

    parse(con) {
      const split = con.split(' ');
      if (split.length !== 3) {
        MsrpSdk.Logger.warn(`[SDP]: Unexpected connection line: ${con}`);
        return false;
      }

      this.netType = split[0];
      this.addrType = split[1];
      this.address = split[2];

      return true;
    }

    toString() {
      let c = '';

      c += `${this.netType} `;
      c += `${this.addrType} `;
      c += this.address;

      return c;
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

      if (tokens[0] === '0') {
        this.start = null;
      } else {
        this.start = MsrpSdk.Util.ntpTimeToDate(tokens[0]);
      }

      if (tokens[1] === '0') {
        this.stop = null;
      } else {
        this.stop = MsrpSdk.Util.ntpTimeToDate(tokens[1]);
      }

      // Don't care about repeat lines at the moment
      this.repeat = lines;

      return true;
    }

    toString() {
      let t = '';

      if (this.start) {
        t += MsrpSdk.Util.dateToNtpTime(this.start);
      } else {
        t += '0';
      }
      t += ' ';
      if (this.stop) {
        t += MsrpSdk.Util.dateToNtpTime(this.stop);
      } else {
        t += '0';
      }

      this.repeat.forEach(line => {
        t += `\r\n${line}`;
      });

      return t;
    }
  }

  class SdpMedia {
    constructor(media) {
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
      this.proto = 'TCP/MSRP';
      this.format = '*';
      this.title = null;
      this.connection = null;
      this.bandwidth = [];
      this.key = null;
      this.resetAttributes();
    }

    addAttribute(name, value) {
      if (!this.attributes[name]) {
        this.attributes[name] = [];
        this.attributeNameOrder.push(name);
      }
      if (value && typeof value === 'string') {
        this.attributes[name].push(value);
      } else if (Array.isArray(value)) {
        this.attributes[name].push(...value);
      }
    }

    removeAttribute(name) {
      if (this.attributes[name]) {
        delete this.attributes[name];
        this.attributeNameOrder.splice(
          this.attributeNameOrder.indexOf(name), 1);
      }
    }

    resetAttributes() {
      this.attributeNameOrder = [];
      this.attributes = {};
    }

    replaceAttribute(oldName, newName, newValue) {
      if (this.attributes[oldName]) {
        delete this.attributes[oldName];
        this.addAttribute(newName, newValue);
        this.attributeNameOrder.splice(this.attributeNameOrder.lastIndexOf(newName), 1);
        this.attributeNameOrder.splice(
          this.attributeNameOrder.indexOf(oldName), 1, newName);
      }
    }

    parse(media) {
      this.reset();

      const lines = media.split(lineEnd);
      const mLine = lines.shift();
      const tokens = mLine.split(' ');
      if (tokens.length < 4) {
        MsrpSdk.Logger.warn(`[SDP]: Unexpected media line: ${mLine}`);
        return false;
      }

      this.media = tokens.shift();
      this.port = parseInt(tokens.shift(), 10);
      this.proto = tokens.shift();
      this.format = tokens.join(' ');

      lines.forEach(line => {
        if (!line || line === lineEnd) {
          MsrpSdk.Logger.warn('[SDP]: Unexpected empty line in SDP (within media)');
          return;
        }
        let value = line.substr(2);
        switch (line.substr(0, 2)) {
          case 'i=':
            this.title = value;
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
            let aName;
            const colonIndex = value.indexOf(':');
            if (colonIndex === -1) {
              aName = value;
              value = null;
            } else {
              aName = value.substr(0, colonIndex);
              value = value.substr(colonIndex + 1);
            }
            this.addAttribute(aName, value);
            break;
          default:
            MsrpSdk.Logger.warn(`[SDP]: Unexpected type (within media): ${line}`);
            break;
        }
      });
      return true;
    }

    toString() {
      let m = '';

      m += `${this.media} `;
      m += `${this.port} `;
      m += `${this.proto} `;
      m += this.format;

      if (this.title) {
        m += `\r\ni=${this.title}`;
      }
      if (this.connection) {
        m += `\r\nc=${this.connection}`;
      }
      this.bandwidth.forEach(bw => {
        m += `\r\nb=${bw}`;
      });
      if (this.key) {
        m += `\r\nk=${this.key}`;
      }
      this.attributeNameOrder.forEach(aName => {
        this.attributes[aName].forEach(aValue => {
          if (aValue === 0) {
            aValue = '0';
          }
          m += `\r\na=${aName}${aValue ? `:${aValue}` : ''}`;
        });
      });

      return m;
    }
  }

  class Sdp {
    constructor(sdp) {
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
      this.resetAttributes();
      this.media = [];
    }

    addAttribute(name, value) {
      if (!this.attributes[name]) {
        this.attributes[name] = [];
        this.attributeNameOrder.push(name);
      }
      if (value && typeof value === 'string') {
        this.attributes[name].push(value);
      } else if (Array.isArray(value)) {
        this.attributes[name].push(...value);
      }
    }

    removeAttribute(name) {
      if (this.attributes[name]) {
        delete this.attributes[name];
        this.attributeNameOrder.splice(
          this.attributeNameOrder.indexOf(name), 1);
      }
    }

    replaceAttribute(oldName, newName, newValue) {
      if (this.attributes[oldName]) {
        delete this.attributes[oldName];
        this.addAttribute(newName, newValue);
        this.attributeNameOrder.splice(this.attributeNameOrder.lastIndexOf(newName), 1);
        this.attributeNameOrder.splice(
          this.attributeNameOrder.indexOf(oldName), 1, newName);
      }
    }

    resetAttributes() {
      this.attributeNameOrder = [];
      this.attributes = {};
    }

    // eslint-disable-next-line complexity
    parse(sdp) {
      let line, value, colonIndex, aName;
      const lines = sdp.split(lineEnd);

      this.reset();

      if (lines[lines.length - 1] === '') {
        // SDP ends in CRLF; remove final array index
        lines.pop();
      }

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
      if (line.substr(0, 2) === 'o=') {
        this.origin = new SdpOrigin(line.substr(2));
      } else {
        MsrpSdk.Logger.warn(`[SDP]: Unexpected SDP origin: ${line}`);
        return false;
      }

      line = lines.shift();
      if (line.substr(0, 2) === 's=') {
        this.sessionName = line.substr(2);
      } else {
        MsrpSdk.Logger.warn(`[SDP]: Unexpected SDP session name: ${line}`);
        return false;
      }

      // Process any other optional pre-timing lines
      while (lines.length > 0 && lines[0].charAt(0) !== 't') {
        line = lines.shift();
        value = line.substr(2);

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
        line = lines.shift().substr(2);
        // Append any following r-lines
        while (lines.length > 0 && lines[0].charAt(0) === 'r') {
          line += `\r\n${lines.shift()}`;
        }

        value = new SdpTiming(line);
        this.timing.push(value);
      }

      if (this.timing.length === 0) {
        MsrpSdk.Logger.warn('[SDP]: No timing line found');
        return false;
      }

      // Process any optional pre-media lines
      while (lines.length > 0 && lines[0].charAt(0) !== 'm') {
        line = lines.shift();
        value = line.substr(2);

        switch (line.substr(0, 2)) {
          case 'z=':
            this.timezone = value;
            break;
          case 'k=':
            this.key = value;
            break;
          case 'a=':
            colonIndex = value.indexOf(':');
            if (colonIndex === -1) {
              aName = value;
              value = null;
            } else {
              aName = value.substr(0, colonIndex);
              value = value.substr(colonIndex + 1);
            }
            this.addAttribute(aName, value);
            break;
          default:
            MsrpSdk.Logger.warn(`[SDP]: Unexpected SDP line (pre-media): ${line}`);
            return false;
        }
      }

      while (lines.length > 0 && lines[0].charAt(0) === 'm') {
        line = lines.shift().substr(2);
        // Append any following lines up to the next m-line
        while (lines.length > 0 && lines[0].charAt(0) !== 'm') {
          line += `\r\n${lines.shift()}`;
        }

        value = new SdpMedia(line);
        this.media.push(value);
      }

      return true;
    }

    toString() {
      let sdp = '';
      sdp += `v=${this.version}\r\n`;
      sdp += `o=${this.origin}\r\n`;
      sdp += `s=${this.sessionName}\r\n`;
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
      if (this.connection) {
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
      this.media.forEach(m => {
        sdp += `m=${m}\r\n`;
      });
      this.attributeNameOrder.forEach(aName => {
        this.attributes[aName].forEach(aValue => {
          if (aValue === 0) {
            aValue = '0';
          }
          sdp += `a=${aName}${aValue ? `:${aValue}` : ''}\r\n`;
        });
      });

      return sdp;
    }
  }

  MsrpSdk.Sdp = Sdp;
};
