module.exports = function (MsrpSdk) {
  var unixToNtpOffset = 2208988800;
  /**
   * @namespace Shared utility functions
   * @private
   */
  var Util = {
    newUriAuthority: function () {
      // Create new URI Authority (used in local MSRP URI)
      // Use a random eight-character alphanumeric string.
      return Math.random().toString(36).substr(2, 8) + ".invalid";
    },
    newSID: function () {
      // Create new Session ID (used in local MSRP URI)
      // RFC 4975 section 14.1 requires 80 bits of randomness
      // Use a random ten-character alphanumeric string.
      return Math.random().toString(36).substr(2, 10);
    },
    newTID: function () {
      // Create new Transaction ID (used for delimiting individual chunks)
      // Use a random eight-character alphanumeric string.
      // Could be longer, but RFC4975 only requires 64-bits of randomness.
      return Math.random().toString(36).substr(2, 8);
    },
    newMID: function () {
      // Create new Message ID (used to identify an individual message, which may be chunked)
      // RFC 4975 suggests a complicated way of ensuring uniqueness, but we're
      // being lazy.
      var now = new Date();
      return (
        MsrpSdk.Util.dateToNtpTime(now) +
        "." +
        Math.random().toString(36).substr(2, 8)
      );
    },
    newFileTransferId: function () {
      // Create new File Transfer ID (see RFC 5547). This must uniquely
      // identify a file transfer within a session, and ideally should be
      // globally unique.
      var now = new Date();
      return (
        MsrpSdk.Util.dateToNtpTime(now) +
        "." +
        Math.random().toString(36).substr(2)
      );
    },
    escapeUser: function (user) {
      // Don't hex-escape ':' (%3A), '+' (%2B), '?' (%3F"), '/' (%2F).
      return encodeURIComponent(decodeURIComponent(user))
        .replace(/%3A/gi, ":")
        .replace(/%2B/gi, "+")
        .replace(/%3F/gi, "?")
        .replace(/%2F/gi, "/");
    },
    normaliseHeader: function (name) {
      // Normalise the header capitalisation
      var parts = name.toLowerCase().split("-"),
        part,
        header = "";
      for (part in parts) {
        if (part !== "0") {
          header += "-";
        }
        header +=
          parts[part].charAt(0).toUpperCase() + parts[part].substring(1);
      }
      switch (header) {
        case "Www-Authenticate":
          return "WWW-Authenticate";
        case "Message-Id":
          return "Message-ID";
      }
      return header;
    },
    isEmpty: function (map) {
      var property;
      for (property in map) {
        if (map.hasOwnProperty(property)) {
          return false;
        }
      }
      return true;
    },
    ntpTimeToDate: function (ntpTime) {
      return new Date((parseInt(ntpTime, 10) - unixToNtpOffset) * 1000);
    },
    dateToNtpTime: function (date) {
      return parseInt(date.getTime() / 1000, 10) + unixToNtpOffset;
    },
    dateToIso8601: function () {
      return new Date().toISOString();
    },
    /**
     * Encodes a string as an SDP filename-string, as defined in RFC 5547.
     * @param {String} str The string to encode.
     * @returns {String} The encoded string.
     */
    encodeSdpFileName: function (str) {
      return str
        .replace(/%/g, "%25")
        .replace(/\0/g, "%00")
        .replace(/\n/g, "%0A")
        .replace(/\r/g, "%0D")
        .replace(/"/g, "%22");
    },
    /**
     * Decodes an SDP filename-string, as defined in RFC 5547.
     * @param {String} str The string to decode.
     * @returns {String} The decoded string.
     */
    decodeSdpFileName: function (str) {
      return str
        .replace(/%00/g, "\0")
        .replace(/%0A/gi, "\n")
        .replace(/%0D/gi, "\r")
        .replace(/%22/g, '"')
        .replace(/%25/g, "%");
    },
    /**
     * Encodes a string as a quoted-string, as defined in RFC 822.
     * Note: does not support folding, as this is not used in MSRP.
     * @param {String} str The string to encode.
     * @returns {String} The encoded string.
     */
    encodeQuotedString: function (str) {
      var chars = str.split(""),
        index;
      for (index in chars) {
        switch (chars[index]) {
          case '"':
          case "\r":
          case "\\":
            // These must be escaped as a quoted-pair
            chars[index] = "\\" + chars[index];
            break;
        }
      }
      return chars.join("");
    },
    /**
     * Decodes a quoted-string, as defined in RFC 822.
     * Note: does not support folding, as this is not used in MSRP.
     * @param {String} str The string to decode.
     * @returns {String} The decoded string.
     */
    decodeQuotedString: function (str) {
      var chars = str.split(""),
        index,
        escaped = false;
      for (index in chars) {
        if (escaped) {
          // Always include this char as-is
          continue;
        }
        if (chars[index] === "\\") {
          escaped = true;
          delete chars[index];
        }
      }
      return chars.join("");
    },

    /**
     * Counts UTF-8 characters
     */
    byteLength: function (str) {
      // returns the byte length of an utf8 string
      var s = str.length;
      for (var i = str.length - 1; i >= 0; i--) {
        var code = str.charCodeAt(i);
        if (code > 0x7f && code <= 0x7ff) s++;
        else if (code > 0x7ff && code <= 0xffff) s += 2;
        if (code >= 0xdc00 && code <= 0xdfff) i--; //trail surrogate
      }
      return s;
    },

    /**
     * Gets the best local network IP address for advertising
     * Prioritizes real network interfaces over virtual ones (Docker, VMs, etc.)
     */
    getLocalNetworkAddress: function () {
      const os = require("os");
      const networkInterfaces = os.networkInterfaces();

      const candidates = [];

      // Collect all non-loopback IPv4 addresses with priority scoring
      for (const name of Object.keys(networkInterfaces)) {
        for (const netInterface of networkInterfaces[name]) {
          // Skip loopback, internal, and IPv6 addresses
          if (!netInterface.internal && netInterface.family === "IPv4") {
            const address = netInterface.address;
            let priority = 0;

            // Prioritize common physical network interface patterns
            if (
              name.toLowerCase().includes("ethernet") ||
              name.toLowerCase().includes("wi-fi") ||
              name.toLowerCase().includes("wlan") ||
              name.toLowerCase().includes("en0") ||
              name.toLowerCase().includes("eth0")
            ) {
              priority += 100;
            }

            // Prefer typical home/office network ranges
            if (
              address.startsWith("192.168.") ||
              address.startsWith("10.") ||
              address.startsWith("172.16.") ||
              address.startsWith("172.20.") ||
              address.startsWith("172.21.") ||
              address.startsWith("172.22.") ||
              address.startsWith("172.23.") ||
              address.startsWith("172.24.") ||
              address.startsWith("172.25.") ||
              address.startsWith("172.26.") ||
              address.startsWith("172.27.") ||
              address.startsWith("172.28.") ||
              address.startsWith("172.29.") ||
              address.startsWith("172.30.") ||
              address.startsWith("172.31.")
            ) {
              priority += 50;
            }

            // Deprioritize Docker networks (common ranges)
            if (
              address.startsWith("172.17.") ||
              address.startsWith("172.18.") ||
              address.startsWith("172.19.")
            ) {
              priority -= 50;
            }

            // Deprioritize virtual interfaces by name
            if (
              name.toLowerCase().includes("docker") ||
              name.toLowerCase().includes("veth") ||
              name.toLowerCase().includes("br-") ||
              name.toLowerCase().includes("vmware") ||
              name.toLowerCase().includes("virtualbox")
            ) {
              priority -= 30;
            }

            candidates.push({
              address: address,
              name: name,
              priority: priority,
            });
          }
        }
      }

      // Sort by priority (highest first) and return the best candidate
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.priority - a.priority);
        return candidates[0].address;
      }

      // Fallback to localhost if no network interface found
      return "127.0.0.1";
    },

    /**
     * Gets the host to advertise in SDP and message paths
     * Uses advertiseHost if configured, otherwise uses host,
     * but auto-detects network IP if host is '0.0.0.0'
     */
    getAdvertiseHost: function () {
      // If advertiseHost is explicitly configured, use it
      if (MsrpSdk.Config.advertiseHost) {
        return MsrpSdk.Config.advertiseHost;
      }

      // If host is '0.0.0.0' (bind to all interfaces),
      // auto-detect the best network IP to advertise
      if (MsrpSdk.Config.host === "0.0.0.0") {
        return MsrpSdk.Util.getLocalNetworkAddress();
      }

      // Otherwise, use the configured host
      return MsrpSdk.Config.host;
    },
  };

  MsrpSdk.Util = Util;
};
