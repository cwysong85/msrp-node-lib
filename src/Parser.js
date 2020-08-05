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
    let startIndex = 0, hasBody = false, endIndex, msgObj;

    // Extract and parse the first line
    endIndex = msg.indexOf(lineEnd);
    if (endIndex === -1) {
      MsrpSdk.Logger.warn('Error parsing message: no CRLF');
      return null;
    }

    const firstLine = msg.substring(startIndex, endIndex);
    const tokens = firstLine.split(' ');
    if (tokens.length < 3 || tokens[0] !== 'MSRP' || tokens[1].length === 0 || tokens[2].length === 0) {
      MsrpSdk.Logger.warn(`Error parsing message. Unexpected first line format: "${firstLine}"`);
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
      MsrpSdk.Logger.warn(`Error parsing message. Unexpected first line format: "${firstLine}"`);
      return null;
    }

    const endLineNoFlag = msgObj.getEndLineNoFlag();
    const endLineNoFlagLength = endLineNoFlag.length;

    // Iterate through the headers, adding them to the object
    startIndex = endIndex + 2;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // If there is a body, there will be an extra CRLF between the headers and the body.
      if (msg.substr(startIndex, 2) === lineEnd) {
        startIndex += 2;
        hasBody = true;
        break;
      }

      // If there is no body, we stop at the end-line.
      if (msg.substr(startIndex, endLineNoFlagLength) === endLineNoFlag) {
        break;
      }

      const parseResult = getNextHeader(msg, startIndex, msgObj);
      if (parseResult > 0) {
        startIndex = parseResult;
      } else {
        return null;
      }
    }

    // Perform further processing on selected headers
    if (!parseKnownHeaders(msgObj)) {
      return null;
    }

    if (hasBody) {
      endIndex = msg.indexOf(lineEnd + endLineNoFlag, startIndex);
      if (endIndex === -1) {
        MsrpSdk.Logger.warn('Error parsing message: No end line after body');
        return null;
      }
      msgObj.body = msg.substring(startIndex, endIndex);
      startIndex = endIndex + 2;
    }

    msgObj.continuationFlag = msg[startIndex + endLineNoFlagLength];
    return msgObj;
  };

  /**
   * Remove double quotes from the start and end of the string, if present.
   *
   * @param {string} str - The string to process.
   * @returns {string} The unquoted string.
   */
  function unq(str) {
    if (str[0] === '"' && str[str.length - 1] === '"') {
      return str.slice(1, -1);
    }
    return str;
  }

  /**
   * Extracts the next header after startIndex, and adds it to the provided message object.
   *
   * @param {string} msg - The message being parsed.
   * @param {number} startIndex - The starting index for the current header being parsed.
   * @param {object} msgObj - The Message object being populated.
   * @returns {number} The start index for the next header or -1 if it encounters an error.
   */
  function getNextHeader(msg, startIndex, msgObj) {
    let name, value;
    const endIndex = msg.indexOf(lineEnd, startIndex);

    if (endIndex === -1) {
      MsrpSdk.Logger.warn('Error parsing header: no CRLF');
      return -1;
    }

    const header = msg.substring(startIndex, endIndex);
    const colonIndex = header.indexOf(':');
    if (colonIndex !== -1) {
      name = header.substring(0, colonIndex).trim();
      value = header.substring(colonIndex + 1).trim();
    }

    if (!name || !value) {
      MsrpSdk.Logger.warn(`Unexpected header format: "${header}"`);
      return -1;
    }

    if (!msgObj.addHeader(name, value)) {
      return -1;
    }
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
    if (str[endIndex] === '"') {
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
    const name = str.substring(startIndex, equalsIndex).trim();
    const value = unq(str.substring(equalsIndex + 1, endIndex).trim());

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

    msgObj.contentDisposition = {
      type: splitValue.shift().trim(),
      param: {}
    };
    for (let idx = 0; idx < splitValue.length; idx++) {
      const splitParam = splitValue[idx].split('=');
      if (splitParam.length !== 2) {
        MsrpSdk.Logger.warn(`Unexpected Content-Disposition param: ${splitValue[idx]}`);
        return false;
      }
      msgObj.contentDisposition.param[splitParam[0].trim()] = unq(splitParam[1].trim());
    }

    return true;
  }

  function parseMsgId(headerArray, msgObj) {
    // We only expect one Message-ID header
    if (headerArray.length !== 1) {
      MsrpSdk.Logger.warn('Multiple Message-ID headers');
      return false;
    }

    msgObj.messageId = headerArray[0].trim();
    if (msgObj.messageId.length < 1) {
      MsrpSdk.Logger.warn(`Unexpected Message-ID header: ${headerArray[0]}`);
      return false;
    }

    return true;
  }

  const headerParsers = {
    'Message-ID': parseMsgId,
    'Failure-Report': parseFailureReport,
    'Status': parseStatus,
    'Content-Disposition': parseContentDisposition,
    'WWW-Authenticate': parseWwwAuthenticate,
    'Use-Path': parseUsePath,
    'Expires': parseExpires,
    'Min-Expires': parseExpires,
    'Max-Expires': parseExpires
  };

  function parseKnownHeaders(msgObj) {
    for (const [name, values] of msgObj.headers) {
      const parseFn = headerParsers[name];
      if (parseFn && !parseFn(values, msgObj)) {
        MsrpSdk.Logger.error(`Parsing failed for header "${name}"`);
        return false;
      }
    }
    return true;
  }
};
