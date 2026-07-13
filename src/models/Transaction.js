const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
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
    // The raw, unmodified row from the CSV for full auditability
    rawRow: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    // Normalized, validated fields used by the matching engine
    normalizedData: {
      id: { type: String },
      timestampMs: { type: Number },        // Unix epoch in milliseconds
      asset: { type: String },              // Canonical uppercase ticker (e.g., 'BTC')
      // Fuzzy matching provenance — for auditability
      assetResolutionMethod: {
        type: String,
        enum: ['exact', 'fuzzy', 'fallback', null],
        default: null,
      },
      assetSimilarityScore: { type: Number, default: null }, // 0–1; null if exact/fallback
      assetOriginalInput: { type: String, default: null },   // Raw string before normalization
      type: { type: String },               // Uppercase type (e.g., 'BUY', 'TRANSFER_IN')
      quantity: { type: Number },
      fee: { type: Number, default: null }, // Feature 1: parsed fee amount, null if not in CSV
    },
    isValid: {
      type: Boolean,
      default: true,
    },
    validationErrors: {
      type: [String],
      default: [],
    },
  },
  { timestamps: true }
);

// Compound index for efficient querying during the matching phase
transactionSchema.index({ runId: 1, source: 1, isValid: 1 });
transactionSchema.index({ runId: 1, 'normalizedData.timestampMs': 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
