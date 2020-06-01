'use strict';

module.exports = function (MsrpSdk) {
  /**
   * Generic representation of a MIME type, along with optional parameters.
   * Provides methods to convert to and from different representations.
   */
  class ContentType {
    /**
     * Creates a new ContentType object.
     */
    constructor() {
      /**
       * The MIME type.
       * @type String
       */
      this.type = '';
      /**
       * The MIME sub type.
       * @type String
       */
      this.subtype = '';
      /**
       * Zero or more content type parameters.
       * @type Object
       */
      this.params = {};
    }

    /**
     * Parses an SDP type selector, as defined in RFC 5547.
     * @param {string} selector The selector value to parse.
     */
    parseSdpTypeSelector(selector) {
      let position = 0,
        endIndex, param, value;

      // Type
      endIndex = selector.indexOf('/', position);
      if (endIndex === -1) {
        // Unexpected input
        return;
      }
      this.type = selector.slice(position, endIndex);
      position = endIndex + 1;

      // Subtype
      endIndex = position;
      while (endIndex < selector.length) {
        if (selector[endIndex] === ';') {
          break;
        }
        endIndex++;
      }
      this.subtype = selector.slice(position, endIndex);
      position = endIndex + 1;

      // Parameters
      this.params = {};
      while (selector[endIndex] === ';') {
        // Parse content type parameter
        endIndex = selector.indexOf('=', position);
        if (endIndex === -1) {
          // Unexpected input
          return;
        }
        param = selector.slice(position, endIndex);
        position = endIndex + 1;

        if (selector[position] !== '"') {
          // Unexpected input
          return;
        }
        position++;
        endIndex = selector.indexOf('"', position);
        if (endIndex === -1) {
          // Unexpected input
          return;
        }
        value = selector.slice(position, endIndex);
        position = endIndex + 1;

        this.params[param] = MsrpSdk.Util.decodeSdpFileName(value);
      }
    }

    /**
     * Encodes the content type as an SDP type selector, as defined in RFC 5547.
     * @returns {string} The encoded selector value.
     */
    toSdpTypeSelector() {
      let selector = '', param;

      selector = selector.concat(this.type, '/', this.subtype);
      for (param in this.params) {
        if (this.params.hasOwnProperty(param)) {
          selector = selector.concat(';', param, '="', MsrpSdk.Util.encodeSdpFileName(this.params[param]), '"');
        }
      }

      return selector;
    }

    /**
     * Parses a Content-Type header, as defined in RFC 2045.
     * Note: Does not allow for unquoted white space.
     * @param {string} header The header value to parse.
     */
    parseContentTypeHeader(header) {
      let position = 0,
        endIndex, param, value;

      // Type
      endIndex = header.indexOf('/', position);
      if (endIndex === -1) {
        // Unexpected input
        return;
      }
      this.type = header.slice(position, endIndex);
      position = endIndex + 1;

      // Subtype
      endIndex = position;
      while (endIndex < header.length) {
        if (header[endIndex] === ';') {
          break;
        }
        endIndex++;
      }
      this.subtype = header.slice(position, endIndex);
      position = endIndex + 1;

      // Parameters
      this.params = {};
      while (header[endIndex] === ';') {
        // Parse content type parameter
        endIndex = header.indexOf('=', position);
        if (endIndex === -1) {
          // Unexpected input
          return;
        }
        param = header.slice(position, endIndex);
        position = endIndex + 1;

        if (header[position] === '"') {
          position++;
          endIndex = header.indexOf('"', position);
          if (endIndex === -1) {
            // Unexpected input
            return;
          }
          while (header[endIndex - 1] === '\\') {
            endIndex = header.indexOf('"', endIndex + 1);
            if (endIndex === -1) {
              // Unexpected input
              return;
            }
          }
        } else {
          endIndex = header.indexOf(' ', position);
          if (endIndex === -1) {
            endIndex = header.length;
          }
        }
        value = header.slice(position, endIndex);
        position = endIndex + 1;

        this.params[param] = MsrpSdk.Util.decodeQuotedString(value);
      }
    }

    /**
     * Encodes the content type as an Content-Type header, as defined in RFC 2045.
     * @returns {string} The encoded header value.
     */
    toContentTypeHeader() {
      let header = '',
        param;

      header = header.concat(this.type, '/', this.subtype);
      for (param in this.params) {
        if (this.params.hasOwnProperty(param)) {
          header = header.concat(';', param, '="', MsrpSdk.Util.encodeQuotedString(this.params[param]), '"');
        }
      }

      return header;
    }
  }

  MsrpSdk.ContentType = ContentType;
};
