module.exports = function(MsrpSdk) {

	var Exceptions = {};

	/**
	 * Creates an UnsupportedMedia exception.
	 * @class Exception thrown by the application's onMessageReceived callback
	 * if it cannot understand the MIME type of a received SEND request.
	 */
	Exceptions.UnsupportedMedia = function() {};
	Exceptions.UnsupportedMedia.prototype = new Error();
	Exceptions.UnsupportedMedia.prototype.constructor = Exceptions.UnsupportedMedia;

	/**
	 * Creates an AbortTransfer exception.
	 * @class Internal exception used to trigger a 413 response to file transfer
	 * chunks.
	 * @private
	 */
	Exceptions.AbortTransfer = function() {};
	Exceptions.AbortTransfer.prototype = new Error();
	Exceptions.AbortTransfer.prototype.constructor = Exceptions.AbortTransfer;

	MsrpSdk.Exceptions = Exceptions;
};
