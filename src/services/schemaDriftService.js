const SchemaDriftLog = require('../models/SchemaDriftLog');

/**
 * FEATURE 5 — SCHEMA DRIFT DETECTION
 *
 * Problem this solves:
 *   Exchange CSV export formats change without notice. A column renamed from
 *   "transaction_id" to "txid", or a new "network" column appearing, can silently
 *   corrupt a reconciliation run — the column alias map absorbs some changes but
 *   not all. Without detection, the first signal of a format change is a
 *   mysterious spike in UNMATCHED results, hours after the run finished.
 *
 * How it works:
 *   1. captureAndDiff() is called at the start of ingestion, before any rows
 *      are processed. It receives the actual headers seen in the incoming CSV.
 *   2. It looks up the most recent SchemaDriftLog for the same source.
 *   3. It diffs current vs previous headers to find additions and removals.
 *   4. If both an addition and a removal occurred, it flags the pair as a
 *      likely rename (heuristic: one-to-one pairing by order of appearance).
 *   5. It persists the new snapshot and returns a human-readable warnings array.
 *
 * The warnings are:
 *   - Stored on the SchemaDriftLog document (full detail)
 *   - Surfaced as strings on ReconciliationRun.schemaDriftWarnings (quick visibility)
 *   - Logged to stdout so they appear in server logs immediately
 *
 * Drift does NOT abort the run. It is advisory. The column alias map may already
 * handle the change gracefully — but the operator is informed either way.
 */

/**
 * Diffs two header arrays and returns structured drift information.
 * @param {string[]} current
 * @param {string[]} previous
 * @returns {{ driftDetected: boolean, addedColumns: string[], removedColumns: string[], likelyRenames: string[][] }}
 */
const diffHeaders = (current, previous) => {
  const currentSet  = new Set(current);
  const previousSet = new Set(previous);

  const addedColumns   = current.filter((h) => !previousSet.has(h));
  const removedColumns = previous.filter((h) => !currentSet.has(h));

  // Heuristic rename detection: pair added and removed columns by position.
  // If exactly N columns were removed and N were added, assume positional renames.
  // This is a best-effort signal, not a guarantee.
  const likelyRenames = [];
  const pairCount = Math.min(addedColumns.length, removedColumns.length);
  for (let i = 0; i < pairCount; i++) {
    likelyRenames.push([removedColumns[i], addedColumns[i]]);
  }

  const driftDetected = addedColumns.length > 0 || removedColumns.length > 0;

  return { driftDetected, addedColumns, removedColumns, likelyRenames };
};

/**
 * Builds human-readable warning strings from a drift result.
 * @param {string} source - 'USER' | 'EXCHANGE'
 * @param {object} drift
 * @returns {string[]}
 */
const buildWarnings = (source, drift) => {
  const warnings = [];

  for (const col of drift.addedColumns) {
    // Check if it's part of a likely rename pair
    const rename = drift.likelyRenames.find(([, added]) => added === col);
    if (!rename) {
      warnings.push(`[SCHEMA DRIFT] ${source}: New column added — "${col}". Verify this is intentional.`);
    }
  }

  for (const col of drift.removedColumns) {
    const rename = drift.likelyRenames.find(([removed]) => removed === col);
    if (!rename) {
      warnings.push(`[SCHEMA DRIFT] ${source}: Column removed — "${col}". Rows missing this field will fail validation.`);
    }
  }

  for (const [removed, added] of drift.likelyRenames) {
    warnings.push(
      `[SCHEMA DRIFT] ${source}: Likely column rename — "${removed}" → "${added}". ` +
      `Check COLUMN_ALIASES in ingestionService.js to ensure the new name is mapped.`
    );
  }

  return warnings;
};

/**
 * Main entry point. Called during ingestion, before any rows are processed.
 *
 * @param {string} runId - Current reconciliation run ID.
 * @param {string} source - 'USER' | 'EXCHANGE'
 * @param {string[]} currentHeaders - Actual headers from the incoming CSV.
 * @returns {Promise<string[]>} Array of human-readable warning strings (empty if no drift).
 */
const captureAndDiff = async (runId, source, currentHeaders) => {
  const warnings = [];

  // Find the most recent snapshot for this source (across all runs)
  const previous = await SchemaDriftLog.findOne({ source })
    .sort({ createdAt: -1 })
    .lean();

  let drift = { driftDetected: false, addedColumns: [], removedColumns: [], likelyRenames: [] };

  if (previous) {
    drift = diffHeaders(currentHeaders, previous.currentHeaders);

    if (drift.driftDetected) {
      const w = buildWarnings(source, drift);
      warnings.push(...w);
      w.forEach((msg) => console.warn(msg));
    } else {
      console.log(`[SchemaDrift] ${source}: No drift detected vs run ${previous.runId}.`);
    }
  } else {
    console.log(`[SchemaDrift] ${source}: No previous snapshot found — this is the first run. Capturing baseline.`);
  }

  // Persist the snapshot for this run (regardless of whether drift was found)
  await SchemaDriftLog.create({
    runId,
    source,
    currentHeaders,
    previousHeaders: previous?.currentHeaders ?? null,
    previousRunId:   previous?.runId ?? null,
    driftDetected:   drift.driftDetected,
    drift: {
      addedColumns:   drift.addedColumns,
      removedColumns: drift.removedColumns,
      likelyRenames:  drift.likelyRenames,
    },
  });

  return warnings;
};

/**
 * Retrieves all schema drift logs for a specific run.
 * @param {string} runId
 * @returns {Promise<object[]>}
 */
const getDriftLogsForRun = async (runId) => {
  return SchemaDriftLog.find({ runId }, { __v: 0 }).lean();
};

module.exports = { captureAndDiff, getDriftLogsForRun };
