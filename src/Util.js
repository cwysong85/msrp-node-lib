'use strict';

module.exports = function (MsrpSdk) {
  const unixToNtpOffset = 2208988800;

  function genRandomString(length) {
    return Math.random()
      .toString(36)
      .substr(2, length);
  }

  /**
     * @namespace Shared utility functions
     * @private
     */
  const Util = {
    newUriAuthority() {
      // Create new URI Authority (used in local MSRP URI)
      // Use a random eight-character alphanumeric string.
      return `${genRandomString(8)}.invalid`;
    },
    newSID() {
      // Create new Session ID (used in local MSRP URI)
      // RFC 4975 section 14.1 requires 80 bits of randomness
      // Use a random ten-character alphanumeric string.
      return genRandomString(10);
    },
    newTID() {
      // Create new Transaction ID (used for delimiting individual chunks)
      // Use a random eight-character alphanumeric string.
      // Could be longer, but RFC4975 only requires 64-bits of randomness.
      return genRandomString(8);
    },
    newMID() {
      // Create new Message ID (used to identify an individual message, which may be chunked)
      // RFC 4975 suggests a complicated way of ensuring uniqueness, but we're
      // being lazy.
      return `${MsrpSdk.Util.dateToNtpTime()}.${genRandomString(8)}`;
    },
    newFileTransferId() {
      // Create new File Transfer ID (see RFC 5547). This must uniquely
      // identify a file transfer within a session, and ideally should be
      // globally unique.
      return `${MsrpSdk.Util.dateToNtpTime()}.${genRandomString()}`;
    },
    escapeUser(user) {
      // Don't hex-escape ':' (%3A), '+' (%2B), '?' (%3F"), '/' (%2F).
      return encodeURIComponent(decodeURIComponent(user))
        .replace(/%3A/ig, ':')
        .replace(/%2B/ig, '+')
        .replace(/%3F/ig, '?')
        .replace(/%2F/ig, '/');
    },
    normaliseHeader(name) {
      // Normalise the header capitalisation
      const header = name ? name.toLowerCase() : '';
      switch (header) {
        case 'www-authenticate':
          return 'WWW-Authenticate';
        case 'message-id':
          return 'Message-ID';
      }
      return header.split('-')
        .map(part => part.charAt(0).toUpperCase() + part.substring(1))
        .join('-');
    },
    isEmpty(map) {
      let property;
      for (property in map) {
        if (map.hasOwnProperty(property)) {
          return false;
        }
      }
      return true;
    },
    ntpTimeToDate(ntpTime) {
      return new Date((parseInt(ntpTime, 10) - unixToNtpOffset) * 1000);
    },
    dateToNtpTime(date) {
      const now = date ? date.getTime() : Date.now();
      return Math.floor(now / 1000) + unixToNtpOffset;
    },
    dateToIso8601() {
      return new Date().toISOString();
    },
    /**
     * Encodes a string as an SDP filename-string, as defined in RFC 5547.
     * @param {String} str The string to encode.
     * @returns {String} The encoded string.
     */
    encodeSdpFileName(str) {
      return str.replace(/%/g, '%25')
        .replace(/\0/g, '%00')
        .replace(/\n/g, '%0A')
        .replace(/\r/g, '%0D')
        .replace(/"/g, '%22');
    },
    /**
     * Decodes an SDP filename-string, as defined in RFC 5547.
     * @param {String} str The string to decode.
     * @returns {String} The decoded string.
     */
    decodeSdpFileName(str) {
      return str.replace(/%00/g, '\0')
        .replace(/%0A/gi, '\n')
        .replace(/%0D/gi, '\r')
        .replace(/%22/g, '"')
        .replace(/%25/g, '%');
    },
    /**
     * Encodes a string as a quoted-string, as defined in RFC 822.
     * Note: does not support folding, as this is not used in MSRP.
     * @param {String} str The string to encode.
     * @returns {String} The encoded string.
     */
    encodeQuotedString(str) {
      const chars = str.split('');
      chars.forEach((char, idx) => {
        switch (char) {
          case '"':
          case '\r':
          case '\\':
            // These must be escaped as a quoted-pair
            chars[idx] = `\\${char}`;
            break;
        }
      });
      return chars.join('');
    },
    /**
     * Decodes a quoted-string, as defined in RFC 822.
     * Note: does not support folding, as this is not used in MSRP.
     * @param {String} str The string to decode.
     * @returns {String} The decoded string.
     */
    decodeQuotedString(str) {
      const chars = str.split('');
      chars.forEach((char, idx) => {
        if (char === '\\' && (idx === 0 || chars[idx - 1])) {
          chars[idx] = '';
        }
      });
      return chars.join('');
    }
  };

  MsrpSdk.Util = Util;
};
