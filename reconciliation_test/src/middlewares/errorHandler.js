const AppError = require('../utils/AppError');

/**
 * Global error handler middleware.
 * Distinguishes between operational errors (safe to expose to client)
 * and programmer errors (log only, send generic message).
 */
const errorHandler = (err, req, res, _next) => {
  // Handle Multer-specific errors
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({
      success: false,
      message: `File too large. Maximum size is ${err.field || 'the file'} limit exceeded.`,
    });
  }

  // Handle Mongoose validation errors
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({
      success: false,
      message: `Database validation error: ${messages.join(', ')}`,
    });
  }

  // Handle Mongoose CastError (invalid ObjectId)
  if (err.name === 'CastError') {
    return res.status(400).json({
      success: false,
      message: `Invalid data format for field: ${err.path}`,
    });
  }

  // Operational errors (expected, safe to share with client)
  if (err.isOperational) {
    return res.status(err.statusCode).json({
      success: false,
      message: err.message,
    });
  }

  // Unknown programmer errors — log full error but send generic response
  console.error('[ERROR] Unhandled error:', err);
  return res.status(500).json({
    success: false,
    message: 'An unexpected internal server error occurred.',
  });
};

module.exports = errorHandler;
