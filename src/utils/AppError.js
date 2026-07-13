/**
 * Custom error class for operational (expected) API errors.
 * Using this allows global error handler to distinguish between
 * programmer errors and expected errors without leaking stack traces.
 */
class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
