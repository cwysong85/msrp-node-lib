'use strict';

// eslint-disable-next-line max-lines-per-function
module.exports = function (MsrpSdk) {
  const lineEnd = '\r\n';

  /**
   * Parses a raw websocket message and returns a Message object.
   *
   * @param {string} msg - Raw string received from the socket.
   * @returns {object} Message object, or null if there an error parsing the message.
   */
  MsrpSdk.parseMessage = function (msg = '') {
    let startIndex = 0, endIndex, msgObj, parseResult;

    // Extract and parse the first line
    endIndex = msg.indexOf(lineEnd);
    if (endIndex === -1) {
      MsrpSdk.Logger.warn('Error parsing message: no CRLF');
      return null;
    }

    const firstLine = msg.substring(startIndex, endIndex);
    const tokens = firstLine.split(' ');
    if (tokens.length < 3 || tokens[0] !== 'MSRP' || tokens[1].length === 0 || tokens[2].length === 0) {
      MsrpSdk.Logger.warn(`Error parsing message. Unexpected first line format: ${firstLine}`);
      return null;
    }

    // Determine whether it is a request or response and construct the appropriate object
    const statusCode = tokens[2].length === 3 ? parseInt(tokens[2], 10) : null;
    if (statusCode) {
      if (tokens.length > 3) {
        const comment = tokens.slice(3).join(' ');
        msgObj = new MsrpSdk.Message.IncomingResponse(tokens[1], statusCode, comment);
      } else {
        msgObj = new MsrpSdk.Message.IncomingResponse(tokens[1], statusCode);
      }
    } else if (tokens.length === 3) {
      msgObj = new MsrpSdk.Message.IncomingRequest(tokens[1], tokens[2]);
    } else {
      MsrpSdk.Logger.warn(`Error parsing message. Unexpected first line format: ${firstLine}`);
      return null;
    }

    // Iterate through the headers, adding them to the object
    startIndex = endIndex + lineEnd.length;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      parseResult = getNextHeader(msg, startIndex, msgObj);
      if (parseResult > 0) {
        startIndex = parseResult;
      } else if (parseResult === 0) {
        break;
      } else {
        return null;
      }
    }

    // Perform further processing on selected headers
    if (!parseKnownHeaders(msgObj)) {
      MsrpSdk.Logger.warn('Error parsing message: parseKnownHeaders failed');
      return null;
    }

    // Extract the message body (if present)
    const endLineNoFlag = msgObj.getEndLineNoFlag();
    if (msg.substr(startIndex, lineEnd.length) === lineEnd) {
      // Empty line after headers indicates presence of a message body
      startIndex += lineEnd.length;
      endIndex = msg.indexOf(lineEnd + endLineNoFlag, startIndex);
      if (endIndex === -1) {
        MsrpSdk.Logger.warn('Error parsing message: no end line after body');
        return null;
      }
      msgObj.body = msg.substring(startIndex, endIndex);
      msgObj.continuationFlag = msg.charAt(endIndex + lineEnd.length + endLineNoFlag.length);
    } else {
      msgObj.continuationFlag = msg.charAt(startIndex + endLineNoFlag.length);
    }

    return msgObj;
  };

  /**
   * Remove any leading or trailing whitespace from the provided string.
   * @param {string} str The string to process.
   * @returns {string} The trimmed string.
   */
  function chomp(str) {
    return str.replace(/^\s+/, '').replace(/\s+$/, '');
  }

  /**
   * Remove double quotes from the start and end of the string, if present.
   * @param {string} str The string to process.
   * @returns {string} The unquoted string.
   */
  function unq(str) {
    return str.replace(/^"/, '').replace(/"$/, '');
  }

  // Extracts the next header after startIndex, and adds it to the provided message object
  // Returns: Positive value: the new message position when a header is extracted
  //          0 if there are no more headers
  //          -1 if it encounters an error
  function getNextHeader(msg, startIndex, msgObj) {
    const endLineNoFlag = msgObj.getEndLineNoFlag();

    // If there is a body, there will be an extra CRLF between the headers and
    // the body. If there is no body, we stop at the end-line.
    if (msg.substr(startIndex, 2) === '\r\n' || msg.substr(startIndex, endLineNoFlag.length) === endLineNoFlag) {
      return 0;
    }

    const endIndex = msg.indexOf('\r\n', startIndex);
    if (endIndex === -1) {
      // Oops - invalid message
      MsrpSdk.Logger.warn('Error parsing header: no CRLF');
      return -1;
    }

    const colonIndex = msg.indexOf(':', startIndex);
    if (colonIndex === -1) {
      // Oops - invalid message
      MsrpSdk.Logger.warn('Error parsing header: no colon');
      return -1;
    }

    const name = chomp(msg.substring(startIndex, colonIndex));
    if (name.length === 0) {
      MsrpSdk.Logger.warn('Error parsing header: no name');
      return -1;
    }

    const value = chomp(msg.substring(colonIndex + 1, endIndex));
    if (name.length === 0) {
      MsrpSdk.Logger.warn('Error parsing header: no value');
      return -1;
    }

    msgObj.addHeader(name, value);

    return endIndex + 2;
  }

  function getNextAuthParam(str, startIndex, obj) {
    let endIndex;

    // Find the next equals sign, which indicates the end of the parameter name
    const equalsIndex = str.indexOf('=', startIndex);
    if (equalsIndex === -1) {
      return -1;
    }

    // Look for the end of this parameter, starting after the equals sign
    endIndex = equalsIndex + 1;
    if (str.charAt(endIndex) === '"') {
      // Quoted string - find the end quote
      // We assume that the string cannot itself contain double quotes,
      // as RFC 2617 makes no mention of escape sequences.
      endIndex = str.indexOf('"', endIndex + 1);
      if (endIndex === -1) {
        return -1;
      }
    }

    // The parameter value continues until the next unquoted comma, or the
    // end of the header line.
    endIndex = str.indexOf(',', endIndex);
    if (endIndex === -1) {
      endIndex = str.length;
    }

    // Trim any whitespace/quotes
    const name = chomp(str.substring(startIndex, equalsIndex));
    const value = unq(chomp(str.substring(equalsIndex + 1, endIndex)));

    // Check we've got something sensible
    if (name.length === 0 || value.length === 0) {
      return -1;
    }

    // Add the param to the result object, and return the current position
    // in the header line.
    obj[name] = value;
    return endIndex + 1;
  }

  function parseWwwAuthenticate(headerArray, msgObj) {
    let hdrIndex, value, authenticate, strIndex;

    // There could be multiple WWW-Authenticate headers, each giving
    // different algorithms or other options.
    for (hdrIndex in headerArray) {
      if (headerArray.hasOwnProperty(hdrIndex)) {
        value = headerArray[hdrIndex];
        authenticate = {};

        if (!value.match(/^Digest /)) {
          return false;
        }

        strIndex = 7;
        while (strIndex !== -1 && strIndex < value.length) {
          strIndex = getNextAuthParam(value, strIndex, authenticate);
        }
        if (strIndex === -1) {
          return false;
        }

        msgObj.authenticate.push(authenticate);
      }
    }
    return true;
  }

  function parseByteRange(headerArray, msgObj) {
    // We only expect one Byte-Range header
    if (headerArray.length !== 1) {
      return false;
    }
    const [value] = headerArray;
    const rangeSepIndex = value.indexOf('-');
    const totalSepIndex = value.indexOf('/', rangeSepIndex);

    if (rangeSepIndex === -1 || totalSepIndex === -1) {
      MsrpSdk.Logger.warn(`Unexpected Byte-Range format: ${value}`);
      return false;
    }

    const range = {};
    range.start = parseInt(chomp(value.substring(0, rangeSepIndex)), 10);
    range.end = chomp(value.substring(rangeSepIndex + 1, totalSepIndex));
    if (range.end === '*') {
      range.end = -1;
    } else {
      range.end = parseInt(range.end, 10);
    }
    range.total = chomp(value.substring(totalSepIndex + 1));
    if (range.total === '*') {
      range.total = -1;
    } else {
      range.total = parseInt(range.total, 10);
    }

    if (isNaN(range.start) || isNaN(range.end) || isNaN(range.total)) {
      MsrpSdk.Logger.warn(`Unexpected Byte-Range values: ${value}`);
      return false;
    }

    msgObj.byteRange = range;
    return true;
  }

  function parseFailureReport(headerArray, msgObj) {
    // We only expect one Failure-Report header
    if (headerArray.length !== 1) {
      MsrpSdk.Logger.warn('Multiple Failure-Report headers');
      return false;
    }

    switch (headerArray[0].toLowerCase()) {
      case 'yes':
        msgObj.responseOn = {
          success: true,
          failure: true
        };
        break;
      case 'no':
        msgObj.responseOn = {
          success: false,
          failure: false
        };
        break;
      case 'partial':
        msgObj.responseOn = {
          success: false,
          failure: true
        };
        break;
      default:
        MsrpSdk.Logger.warn(`Unexpected Failure-Report header: ${headerArray[0]}`);
        return false;
    }

    return true;
  }

  function parseStatus(headerArray, msgObj) {
    // We only expect Status headers on REPORT requests.  Ignore the header
    // if we find it on a response.
    if (msgObj instanceof MsrpSdk.Message.Response) {
      MsrpSdk.Logger.debug('Ignoring Status header on response');
      return true;
    }

    // We only expect one Status header
    if (headerArray.length !== 1) {
      MsrpSdk.Logger.warn('Multiple Status headers');
      return false;
    }

    const splitValue = headerArray[0].split(' ');
    if (splitValue.length < 2 || splitValue.shift() !== '000') {
      MsrpSdk.Logger.warn(`Unexpected Status header: ${headerArray[0]}`);
      return false;
    }

    msgObj.status = parseInt(splitValue.shift(), 10);
    msgObj.comment = splitValue.join(' ');

    return true;
  }

  function parseUsePath(headerArray, msgObj) {
    // We only expect one Use-Path header
    if (headerArray.length !== 1) {
      MsrpSdk.Logger.warn('Multiple Use-Path headers');
      return false;
    }

    msgObj.usePath = headerArray[0].split(' ');
    if (msgObj.usePath.length < 1) {
      MsrpSdk.Logger.warn(`Unexpected Use-Path header: ${headerArray[0]}`);
      return false;
    }

    return true;
  }

  function parseExpires(headerArray, msgObj) {
    // We only expect one Expires header
    if (headerArray.length !== 1) {
      MsrpSdk.Logger.warn('Multiple Expires headers');
      return false;
    }

    msgObj.expires = parseInt(headerArray[0], 10);
    if (isNaN(msgObj.expires)) {
      MsrpSdk.Logger.warn(`Unexpected Expires header: ${headerArray[0]}`);
      return false;
    }

    return true;
  }

  function parseContentDisposition(headerArray, msgObj) {
    let index, splitParam;

    // We only expect MIME headers on SEND requests.  Ignore the header
    // if we find it on a response.
    if (msgObj instanceof MsrpSdk.Message.Response) {
      MsrpSdk.Logger.debug('Ignoring Content-Disposition header on response');
      return true;
    }

    // We only expect one Content-Disposition header
    if (headerArray.length !== 1) {
      MsrpSdk.Logger.warn('Multiple Content-Disposition headers');
      return false;
    }

    const splitValue = headerArray[0].split(';');
    if (splitValue.length < 1) {
      MsrpSdk.Logger.warn(`Unexpected Content-Disposition header: ${headerArray[0]}`);
      return false;
    }

    msgObj.contentDisposition = {};
    msgObj.contentDisposition.type = chomp(splitValue.shift());
    msgObj.contentDisposition.param = {};
    for (index in splitValue) {
      if (splitValue.hasOwnProperty(index)) {
        splitParam = splitValue[index].split('=');
        if (splitParam.length !== 2) {
          MsrpSdk.Logger.warn(`Unexpected Content-Disposition param: ${splitValue[index]}`);
          return false;
        }
        msgObj.contentDisposition.param[chomp(splitParam[0])] = unq(chomp(splitParam[1]));
      }
    }

    return true;
  }

  function parseMsgId(headerArray, msgObj) {
    // We only expect one Message-ID header
    if (headerArray.length !== 1) {
      MsrpSdk.Logger.warn('Multiple Message-ID headers');
      return false;
    }

    msgObj.messageId = chomp(headerArray[0]);
    if (msgObj.messageId.length < 1) {
      MsrpSdk.Logger.warn(`Unexpected Message-ID header: ${headerArray[0]}`);
      return false;
    }

    return true;
  }

  const headerParsers = {
    'Message-ID': parseMsgId,
    'Failure-Report': parseFailureReport,
    'Byte-Range': parseByteRange,
    'Status': parseStatus,
    'Content-Disposition': parseContentDisposition,
    'WWW-Authenticate': parseWwwAuthenticate,
    'Use-Path': parseUsePath,
    'Expires': parseExpires,
    'Min-Expires': parseExpires,
    'Max-Expires': parseExpires
  };

  function parseKnownHeaders(msgObj) {
    let header, parseFn;
    for (header in msgObj.headers) {
      if (msgObj.headers.hasOwnProperty(header)) {
        parseFn = headerParsers[header];
        if (!parseFn) {
          // Ignore unknown headers
          continue;
        }

        if (!parseFn(msgObj.headers[header], msgObj)) {
          MsrpSdk.Logger.error(`Parsing failed for header ${header}`);
          return false;
        }
      }
    }

    return true;
  }
};
