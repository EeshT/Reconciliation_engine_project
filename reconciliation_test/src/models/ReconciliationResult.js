const mongoose = require('mongoose');

const CATEGORIES = [
  'MATCHED',
  'FEE_MATCHED',        // Feature 1: quantity reconciled only after fee deduction
  'CONFLICTING',
  'UNMATCHED_USER',
  'UNMATCHED_EXCHANGE',
];

const MATCH_PASSES = [
  'PASS_1_EXACT_ID',     // Feature 4: matched by identical transaction ID
  'PASS_2_STRICT',       // Feature 4: matched by sliding window at configured tolerance
  'PASS_3_RELAXED',      // Feature 4: matched by sliding window at 5× relaxed tolerance
];

const CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'];

const reconciliationResultSchema = new mongoose.Schema(
  {
    runId: {
      type: String,
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: CATEGORIES,
      required: true,
    },
    userTransaction: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    exchangeTransaction: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    reason: {
      type: String,
      required: true,
    },
    // ── Feature 4: Multi-Pass fields ──────────────────────────────────────────
    matchPass: {
      type: String,
      enum: [...MATCH_PASSES, null],
      default: null,
    },
    confidenceLevel: {
      type: String,
      enum: [...CONFIDENCE_LEVELS, null],
      default: null,
    },
    // ── Feature 1: Fee reconciliation fields ──────────────────────────────────
    feeDeducted: {
      type: Number,
      default: null,  // null unless category === 'FEE_MATCHED'
    },
  },
  { timestamps: true }
);

reconciliationResultSchema.index({ runId: 1, category: 1 });
reconciliationResultSchema.index({ runId: 1, confidenceLevel: 1 }); // Feature 4: filter by confidence

module.exports = mongoose.model('ReconciliationResult', reconciliationResultSchema);
