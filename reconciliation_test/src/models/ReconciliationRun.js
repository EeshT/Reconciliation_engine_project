const mongoose = require('mongoose');

const reconciliationRunSchema = new mongoose.Schema(
  {
    runId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'COMPLETED', 'FAILED'],
      default: 'PENDING',
    },
    config: {
      timestampToleranceSeconds: { type: Number, required: true },
      quantityTolerancePct:      { type: Number, required: true },
    },
    summary: {
      totalUser:          { type: Number, default: 0 },
      totalExchange:      { type: Number, default: 0 },
      invalidUser:        { type: Number, default: 0 },
      invalidExchange:    { type: Number, default: 0 },
      dlqUser:            { type: Number, default: 0 },
      dlqExchange:        { type: Number, default: 0 },
      duplicatesUser:     { type: Number, default: 0 },
      duplicatesExchange: { type: Number, default: 0 },
      matched:            { type: Number, default: 0 },
      feeMatched:         { type: Number, default: 0 },  // Feature 1
      conflicting:        { type: Number, default: 0 },
      unmatchedUser:      { type: Number, default: 0 },
      unmatchedExchange:  { type: Number, default: 0 },
      // Feature 4: breakdown by confidence tier
      matchedHigh:        { type: Number, default: 0 },
      matchedMedium:      { type: Number, default: 0 },
      matchedLow:         { type: Number, default: 0 },
    },
    // Feature 5: drift warnings surfaced at the run level for quick visibility
    schemaDriftWarnings: {
      type: [String],
      default: [],
    },
    errorMessage: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReconciliationRun', reconciliationRunSchema);
