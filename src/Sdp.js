'use strict';

// eslint-disable-next-line max-lines-per-function
module.exports = function (MsrpSdk) {
  const lineEnd = '\r\n';
  const Sdp = {};

  /**
   * @namespace Encapsulates all of the SDP classes.
   * @private
   */
  Sdp.Session = function (sdp) {
    if (sdp) {
      // Parse the provided SDP
      if (!this.parse(sdp)) {
        throw new Error('Failed to parse SDP');
      }
    } else {
      // Set some sensible defaults
      this.reset();
    }
  };

  Sdp.Session.prototype.reset = function () {
    this.version = 0;
    this.origin = new MsrpSdk.Sdp.Origin();
    this.sessionName = ' ';
    this.sessionInfo = null;
    this.uri = null;
    this.email = null;
    this.phone = null;
    this.connection = new MsrpSdk.Sdp.Connection();
    this.bandwidth = [];
    this.timing = [new MsrpSdk.Sdp.Timing()];
    this.timezone = null;
    this.key = null;
    this.resetAttributes();
    this.media = [];
  };

  Sdp.Session.prototype.addAttribute = function (name, value) {
    if (!this.attributes[name]) {
      this.attributes[name] = [];
      this.attributeNameOrder.push(name);
    }
    if (value && typeof value === 'string') {
      this.attributes[name].push(...value.split(' '));
    }
  };

  Sdp.Session.prototype.removeAttribute = function (name) {
    if (this.attributes[name]) {
      delete this.attributes[name];
      this.attributeNameOrder.splice(
        this.attributeNameOrder.indexOf(name), 1);
    }
  };

  Sdp.Session.prototype.replaceAttribute = function (oldName, newName, newValue) {
    if (this.attributes[oldName]) {
      delete this.attributes[oldName];
      this.addAttribute(newName, newValue);
      this.attributeNameOrder.splice(this.attributeNameOrder.lastIndexOf(newName), 1);
      this.attributeNameOrder.splice(
        this.attributeNameOrder.indexOf(oldName), 1, newName);
    }
  };

  Sdp.Session.prototype.resetAttributes = function () {
    this.attributeNameOrder = [];
    this.attributes = {};
  };

  // eslint-disable-next-line complexity
  Sdp.Session.prototype.parse = function (sdp) {
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
      this.origin = new MsrpSdk.Sdp.Origin(line.substr(2));
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
      if (line === lineEnd) {
        break;
      }
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
          this.connection = new MsrpSdk.Sdp.Connection(value);
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

      value = new MsrpSdk.Sdp.Timing(line);
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

      value = new MsrpSdk.Sdp.Media(line);
      this.media.push(value);
    }

    return true;
  };

  Sdp.Session.prototype.toString = function () {
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
  };

  Sdp.Origin = function (origin) {
    if (origin) {
      if (!this.parse(origin)) {
        // Parse the provided origin line
        throw new Error('Cannot parse SDP o-line');
      }
    } else {
      // Set some sensible defaults
      this.reset();
    }
  };

  Sdp.Origin.prototype.reset = function () {
    this.username = '-';
    this.id = MsrpSdk.Util.dateToNtpTime();
    this.version = this.sessId;
    this.netType = 'IN';
    this.addrType = 'IP4';
    this.address = 'address.invalid';
  };

  Sdp.Origin.prototype.parse = function (origin) {
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
  };

  Sdp.Origin.prototype.toString = function () {
    let o = '';

    o += `${this.username} `;
    o += `${this.id} `;
    o += `${this.version} `;
    o += `${this.netType} `;
    o += `${this.addrType} `;
    o += this.address;

    return o;
  };

  Sdp.Connection = function (conn) {
    if (conn) {
      // Parse the provided connection line
      if (!this.parse(conn)) {
        throw new Error('Call parse SDP c-line');
      }
    } else {
      // Set some sensible defaults
      this.reset();
    }
  };

  Sdp.Connection.prototype.reset = function () {
    this.netType = 'IN';
    this.addrType = 'IP4';
    this.address = 'address.invalid';
  };

  Sdp.Connection.prototype.parse = function (con) {
    const split = con.split(' ');
    if (split.length !== 3) {
      MsrpSdk.Logger.warn(`[SDP]: Unexpected connection line: ${con}`);
      return false;
    }

    this.netType = split[0];
    this.addrType = split[1];
    this.address = split[2];

    return true;
  };

  Sdp.Connection.prototype.toString = function () {
    let c = '';

    c += `${this.netType} `;
    c += `${this.addrType} `;
    c += this.address;

    return c;
  };

  Sdp.Timing = function (timing) {
    if (timing) {
      // Parse the provided timing line
      if (!this.parse(timing)) {
        throw new Error('Cannot parse SDP t-line');
      }
    } else {
      // Set some sensible defaults
      this.reset();
    }
  };

  Sdp.Timing.prototype.reset = function () {
    this.start = null;
    this.stop = null;
    this.repeat = [];
  };

  // Parse expects to be passed the full t-line, plus any following r-lines
  Sdp.Timing.prototype.parse = function (timing) {
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
  };

  Sdp.Timing.prototype.toString = function () {
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
  };

  Sdp.Media = function (media) {
    if (media) {
      // Parse the provided media line
      if (!this.parse(media)) {
        throw new Error('Cannot parse SDP m-line');
      }
    } else {
      // Set some sensible defaults
      this.reset();
    }
  };

  Sdp.Media.prototype.reset = function () {
    this.media = 'message';
    this.port = 2855;
    this.proto = 'TCP/MSRP';
    this.format = '*';
    this.title = null;
    this.connection = null;
    this.bandwidth = [];
    this.key = null;
    this.resetAttributes();
  };

  Sdp.Media.prototype.addAttribute = function (name, value) {
    if (!this.attributes[name]) {
      this.attributes[name] = [];
      this.attributeNameOrder.push(name);
    }
    if (value && typeof value === 'string') {
      this.attributes[name] = this.attributes[name].concat(value.split(' '));
    }
  };

  Sdp.Media.prototype.removeAttribute = function (name) {
    if (this.attributes[name]) {
      delete this.attributes[name];
      this.attributeNameOrder.splice(
        this.attributeNameOrder.indexOf(name), 1);
    }
  };

  Sdp.Media.prototype.resetAttributes = function () {
    this.attributeNameOrder = [];
    this.attributes = {};
  };

  Sdp.Media.prototype.replaceAttribute = function (oldName, newName, newValue) {
    if (this.attributes[oldName]) {
      delete this.attributes[oldName];
      this.addAttribute(newName, newValue);
      this.attributeNameOrder.splice(this.attributeNameOrder.lastIndexOf(newName), 1);
      this.attributeNameOrder.splice(
        this.attributeNameOrder.indexOf(oldName), 1, newName);
    }
  };

  Sdp.Media.prototype.parse = function (media) {
    let index, aName;

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

    return lines.every(line => {
      let value = line.substr(2);
      switch (line.substr(0, 2)) {
        case 'i=':
          this.title = value;
          break;
        case 'c=':
          this.connection = new MsrpSdk.Sdp.Connection(value);
          if (!this.connection) {
            return false;
          }
          break;
        case 'b=':
          this.bandwidth.push(value);
          break;
        case 'k=':
          this.key = value;
          break;
        case 'a=':
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
          MsrpSdk.Logger.warn(`[SDP]: Unexpected type (within media): ${lines[index]}`);
          return false;
      }
      return true;
    });
  };

  Sdp.Media.prototype.toString = function () {
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
  };

  Sdp.parseFileAttributes = function (media) {
    const fileParams = {};
    const selector = {};
    const fileSelectorString = media.attributes['file-selector'][0];
    let position = 0;
    let colonIndex, name, value, endIndex;

    // Separate the file-selector components
    while (position < fileSelectorString.length) {
      if (fileSelectorString.charAt(position) === ' ') {
        position++;
        continue;
      }

      colonIndex = fileSelectorString.indexOf(':', position);
      if (colonIndex === -1) {
        break;
      }

      name = fileSelectorString.slice(position, colonIndex);
      position = colonIndex + 1;

      if (fileSelectorString.charAt(position) === '"') {
        // Grab everything within the quotes (possibly including spaces)
        position++;
        endIndex = fileSelectorString.indexOf('"', position);
        if (endIndex === -1) {
          break;
        }
        value = fileSelectorString.slice(position, endIndex);
        position = endIndex + 1;
      } else if (name === 'type') {
        let quoted = false;
        // Further parsing needed; find the next unquoted space
        endIndex = position;
        while (endIndex < fileSelectorString.length &&
          (quoted || fileSelectorString.charAt(endIndex) !== ' ')) {
          if (fileSelectorString.charAt(endIndex) === '"') {
            quoted = !quoted;
          }
          endIndex++;
        }
        value = new MsrpSdk.ContentType();
        value.parseSdpTypeSelector(fileSelectorString.slice(position, endIndex));
        position = endIndex + 1;
      } else {
        // Grab everything until the next space
        endIndex = fileSelectorString.indexOf(' ', position);
        if (endIndex === -1) {
          endIndex = fileSelectorString.length;
        }
        value = fileSelectorString.slice(position, endIndex);
        position = endIndex + 1;
      }

      switch (name) {
        case 'name':
          selector.name = MsrpSdk.Util.decodeSdpFileName(value);
          break;
        case 'size':
          selector.size = parseInt(value, 10);
          break;
        case 'type':
          selector.type = value;
          break;
        case 'hash':
          if (!selector.hash) {
            selector.hash = {};
          }
          colonIndex = value.indexOf(':');
          selector.hash[value.substring(0, colonIndex)] =
            value.substring(colonIndex + 1);
          break;
        default:
          continue;
      }
    }
    fileParams.selector = selector;

    fileParams.id = media.attributes['file-transfer-id'][0];
    fileParams.disposition = media.attributes['file-disposition'][0] || 'render';
    if (media.title) {
      fileParams.description = media.title;
    }
    if (media.attributes['file-icon']) {
      fileParams.icon = media.attributes['file-icon'][0];
    }

    return fileParams;
  };

  MsrpSdk.Sdp = Sdp;
};
