const mongoose = require('mongoose');

/**
 * Dead Letter Queue (DLQ) — stores rows that caused unhandled exceptions
 * during ingestion, distinct from rows that failed validation (isValid: false).
 *
 * A validation failure is an EXPECTED bad row (wrong type, missing field).
 * A DLQ entry is an UNEXPECTED crash during processing — a signal of a
 * parser bug, a memory error, or a deeply malformed input structure.
 *
 * Keeping them separate means:
 *   - invalidUser/invalidExchange counts in the summary reflect data quality
 *   - DLQ counts flag engineering-level issues requiring developer attention
 */
const deadLetterQueueSchema = new mongoose.Schema(
  {
    runId: {
      type: String,
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: ['USER', 'EXCHANGE'],
      required: true,
    },
    // The raw buffer/string as received from csv-parser before any processing
    rawPayload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    // The row index (1-based) in the CSV for developer traceability
    rowIndex: {
      type: Number,
      default: null,
    },
    // The error that caused the row to be routed here
    errorMessage: {
      type: String,
      required: true,
    },
    errorStack: {
      type: String,
      default: null,
    },
    // Stage at which the failure occurred
    failureStage: {
      type: String,
      enum: ['KEY_NORMALIZATION', 'SCHEMA_VALIDATION', 'TIMESTAMP_PARSE', 'QUANTITY_PARSE', 'ASSET_NORMALIZE', 'DB_INSERT', 'UNKNOWN'],
      default: 'UNKNOWN',
    },
    // Whether a developer has reviewed and resolved this entry
    resolved: {
      type: Boolean,
      default: false,
    },
    resolutionNote: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

deadLetterQueueSchema.index({ runId: 1, resolved: 1 });
deadLetterQueueSchema.index({ runId: 1, source: 1 });

module.exports = mongoose.model('DeadLetterQueue', deadLetterQueueSchema);
