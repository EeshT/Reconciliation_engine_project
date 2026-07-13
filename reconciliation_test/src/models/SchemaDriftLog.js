const mongoose = require('mongoose');

/**
 * SchemaDriftLog — Feature 5: Schema Drift Detection
 *
 * Stores the column header snapshot for each source (USER / EXCHANGE) on every
 * completed ingestion. Before ingestion starts, the engine diffs the incoming
 * headers against the most recent snapshot for the same source and records any
 * additions, removals, or renames.
 *
 * "Renames" are detected heuristically: if one column is removed and one is added
 * in the same run, they are flagged as a likely rename rather than two independent
 * changes.
 */
const schemaDriftLogSchema = new mongoose.Schema(
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
    // The raw column headers seen in this run's CSV file
    currentHeaders: {
      type: [String],
      required: true,
    },
    // The headers from the previous run for the same source (null on first run)
    previousHeaders: {
      type: [String],
      default: null,
    },
    // The runId that produced previousHeaders — for cross-referencing
    previousRunId: {
      type: String,
      default: null,
    },
    // True if any drift was detected vs the previous run
    driftDetected: {
      type: Boolean,
      default: false,
    },
    drift: {
      addedColumns:   { type: [String], default: [] },
      removedColumns: { type: [String], default: [] },
      // Pairs of [removedColumn, addedColumn] that look like renames
      likelyRenames:  { type: [[String]], default: [] },
    },
  },
  { timestamps: true }
);

schemaDriftLogSchema.index({ source: 1, createdAt: -1 }); // fast "latest snapshot per source" lookup

module.exports = mongoose.model('SchemaDriftLog', schemaDriftLogSchema);
