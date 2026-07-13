const csv = require('csv-parser');
const fs = require('fs');
const { z } = require('zod');
const Transaction = require('../models/Transaction');
const DeadLetterQueue = require('../models/DeadLetterQueue');
const { normalizeAsset, normalizeType } = require('../utils/normalizer');
const { captureAndDiff } = require('./schemaDriftService'); // Feature 5

const BATCH_SIZE = 500;

// ── Column alias map ──────────────────────────────────────────────────────────
const COLUMN_ALIASES = {
  id:        ['id', 'transaction_id', 'tx_id', 'txid', 'transaction_hash', 'hash', 'ref'],
  timestamp: ['timestamp', 'date', 'datetime', 'time', 'created_at', 'trade_time', 'ts'],
  asset:     ['asset', 'coin', 'currency', 'symbol', 'ticker', 'crypto'],
  type:      ['type', 'transaction_type', 'tx_type', 'side', 'action', 'direction'],
  quantity:  ['quantity', 'amount', 'qty', 'volume', 'size', 'units'],
  // Feature 1: fee column aliases
  fee:       ['fee', 'transaction_fee', 'network_fee', 'trading_fee', 'fees', 'commission'],
};

const buildColumnMap = (headers) => {
  const map = {};
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      if (headers.includes(alias)) {
        map[alias] = canonical;
        break;
      }
    }
  }
  return map;
};

const normalizeKeys = (row, columnMap) => {
  const normalized = {};
  for (const key of Object.keys(row)) {
    const lk = key.toLowerCase().trim().replace(/\s+/g, '_');
    const canonical = columnMap[lk] || lk;
    normalized[canonical] = row[key];
  }
  return normalized;
};

const rawRowSchema = z.object({
  id:        z.string().min(1, 'Transaction ID is required'),
  timestamp: z.string().min(1, 'Timestamp is required'),
  asset:     z.string().min(1, 'Asset is required'),
  type:      z.string().min(1, 'Type is required'),
  quantity:  z.string().or(z.number()).refine(
    (v) => v !== null && v !== undefined && String(v).trim() !== '',
    { message: 'Quantity is required' }
  ),
  // fee is optional — not all CSVs include it
  fee: z.string().or(z.number()).optional().nullable(),
});

const parseTimestamp = (rawTimestamp) => {
  if (!rawTimestamp) return { timestampMs: null, error: 'Missing timestamp' };
  const trimmed = String(rawTimestamp).trim();
  if (/^\d{4}-\d{2}-\d{2}T$/.test(trimmed)) {
    return { timestampMs: null, error: `Incomplete ISO timestamp (missing time): "${trimmed}"` };
  }
  const asNumber = Number(trimmed);
  if (!isNaN(asNumber) && trimmed !== '') {
    const timestampMs = asNumber < 1e12 ? asNumber * 1000 : asNumber;
    if (timestampMs > 0) return { timestampMs, error: null };
  }
  const parsed = new Date(trimmed);
  if (!isNaN(parsed.getTime())) return { timestampMs: parsed.getTime(), error: null };
  return { timestampMs: null, error: `Unparseable timestamp: "${rawTimestamp}"` };
};

const parseQuantity = (rawQuantity) => {
  if (rawQuantity === null || rawQuantity === undefined || String(rawQuantity).trim() === '') {
    return { quantity: null, error: 'Missing quantity' };
  }
  const cleaned = String(rawQuantity).replace(/[,$€£]/g, '').trim();
  const parsed = parseFloat(cleaned);
  if (isNaN(parsed)) return { quantity: null, error: `Non-numeric quantity: "${rawQuantity}"` };
  if (parsed < 0) {
    return { quantity: null, error: `Negative quantity is invalid: ${parsed}. Use type=SELL with a positive quantity instead.` };
  }
  return { quantity: parsed, error: null };
};

/**
 * Feature 1 — Parse fee field.
 * Fee is always optional. Returns null (not an error) if absent or unparseable
 * as a non-numeric — we only warn; we never invalidate a row because of a bad fee.
 * @param {*} rawFee
 * @returns {{ fee: number|null, warning: string|null }}
 */
const parseFee = (rawFee) => {
  if (rawFee === null || rawFee === undefined || String(rawFee).trim() === '') {
    return { fee: null, warning: null }; // legitimately absent
  }
  const cleaned = String(rawFee).replace(/[,$€£]/g, '').trim();
  const parsed = parseFloat(cleaned);
  if (isNaN(parsed) || parsed < 0) {
    return { fee: null, warning: `Unparseable or negative fee value "${rawFee}" — ignored for matching.` };
  }
  return { fee: parsed, warning: null };
};

const sendToDLQ = async ({ runId, source, rawPayload, rowIndex, error, failureStage }) => {
  try {
    await DeadLetterQueue.create({
      runId, source, rawPayload, rowIndex,
      errorMessage: error.message || String(error),
      errorStack: error.stack || null,
      failureStage,
    });
    console.warn(`[DLQ] Run=${runId} source=${source} row=${rowIndex} stage=${failureStage}: ${error.message}`);
  } catch (dlqErr) {
    console.error(`[DLQ] CRITICAL: Failed to write to DLQ for run=${runId}:`, dlqErr.message);
  }
};

const processRow = async (rawRow, columnMap, runId, source, rowIndex) => {
  let normalizedRow = null;

  try {
    normalizedRow = normalizeKeys(rawRow, columnMap);
  } catch (err) {
    await sendToDLQ({ runId, source, rawPayload: rawRow, rowIndex, error: err, failureStage: 'KEY_NORMALIZATION' });
    return null;
  }

  const validationErrors = [];

  try {
    const schemaResult = rawRowSchema.safeParse(normalizedRow);
    if (!schemaResult.success) {
      schemaResult.error.errors.forEach((e) => validationErrors.push(e.message));
    }
  } catch (err) {
    await sendToDLQ({ runId, source, rawPayload: normalizedRow, rowIndex, error: err, failureStage: 'SCHEMA_VALIDATION' });
    return null;
  }

  let timestampMs = null;
  try {
    const result = parseTimestamp(normalizedRow.timestamp);
    timestampMs = result.timestampMs;
    if (result.error) validationErrors.push(result.error);
  } catch (err) {
    await sendToDLQ({ runId, source, rawPayload: normalizedRow, rowIndex, error: err, failureStage: 'TIMESTAMP_PARSE' });
    return null;
  }

  let quantity = null;
  try {
    const result = parseQuantity(normalizedRow.quantity);
    quantity = result.quantity;
    if (result.error) validationErrors.push(result.error);
  } catch (err) {
    await sendToDLQ({ runId, source, rawPayload: normalizedRow, rowIndex, error: err, failureStage: 'QUANTITY_PARSE' });
    return null;
  }

  // Feature 1: parse fee — never invalidates the row, only records a warning
  let fee = null;
  try {
    const result = parseFee(normalizedRow.fee);
    fee = result.fee;
    if (result.warning) validationErrors.push(`WARNING: ${result.warning}`);
  } catch (err) {
    // Fee parse exceptions are non-fatal — log and continue
    console.warn(`[Ingestion] Fee parse exception for row ${rowIndex}: ${err.message}`);
  }

  let assetResult = null;
  try {
    assetResult = normalizeAsset(normalizedRow.asset);
    if (!assetResult.canonical) validationErrors.push('Asset could not be normalized');
  } catch (err) {
    await sendToDLQ({ runId, source, rawPayload: normalizedRow, rowIndex, error: err, failureStage: 'ASSET_NORMALIZE' });
    return null;
  }

  const normalizedType = normalizeType(normalizedRow.type);
  if (!normalizedType) validationErrors.push('Type is missing or could not be normalized');

  // A row is invalid only if core fields failed — fee warnings don't invalidate
  const isValid = validationErrors.filter((e) => !e.startsWith('WARNING:')).length === 0;

  return {
    runId,
    source,
    rawRow: normalizedRow,
    normalizedData: {
      id:                    normalizedRow.id || null,
      timestampMs:           timestampMs || null,
      asset:                 assetResult.canonical,
      assetResolutionMethod: assetResult.method,
      assetSimilarityScore:  assetResult.similarity,
      assetOriginalInput:    assetResult.originalInput,
      type:                  normalizedType,
      quantity,
      fee,   // Feature 1: stored on every transaction; null if not present in CSV
    },
    isValid,
    validationErrors,
  };
};

const flagDuplicates = async (runId, source) => {
  const seen = new Set();
  let dupCount = 0;
  const transactions = await Transaction.find(
    { runId, source, isValid: true },
    { _id: 1, 'normalizedData.id': 1 }
  ).sort({ createdAt: 1 }).lean();

  for (const tx of transactions) {
    const txId = tx.normalizedData?.id;
    if (!txId) continue;
    if (seen.has(txId)) {
      await Transaction.findByIdAndUpdate(tx._id, {
        isValid: false,
        $push: { validationErrors: `Duplicate transaction_id "${txId}" — only the first occurrence is used for matching` },
      });
      dupCount++;
    } else {
      seen.add(txId);
    }
  }
  return dupCount;
};

/**
 * Ingests a CSV file. Now also runs schema drift detection (Feature 5)
 * and parses the optional fee column (Feature 1).
 *
 * @param {string} filePath
 * @param {string} source - 'USER' | 'EXCHANGE'
 * @param {string} runId
 * @returns {Promise<{ total, invalid, dlq, duplicates, driftWarnings }>}
 */
const ingestFile = (filePath, source, runId) => {
  return new Promise((resolve, reject) => {
    const batch = [];
    let totalCount   = 0;
    let invalidCount = 0;
    let dlqCount     = 0;
    let columnMap    = null;
    let driftWarningsPromise = Promise.resolve([]); // Feature 5: resolved async

    const flushBatch = async () => {
      if (batch.length === 0) return;
      const toInsert = [...batch];
      batch.length = 0;
      try {
        await Transaction.insertMany(toInsert, { ordered: false });
      } catch (err) {
        const writeErrors = err.writeErrors || [];
        console.error(`[Ingestion] Batch insert partial failure: ${writeErrors.length} docs failed. source=${source}`);
        for (const writeErr of writeErrors) {
          const failedDoc = toInsert[writeErr.index];
          await sendToDLQ({
            runId, source,
            rawPayload: failedDoc?.rawRow ?? failedDoc,
            rowIndex: null,
            error: new Error(writeErr.errmsg || 'DB insert error'),
            failureStage: 'DB_INSERT',
          });
          dlqCount++;
        }
      }
    };

    const stream = fs
      .createReadStream(filePath)
      .pipe(csv({
        mapHeaders: ({ header }) => header.toLowerCase().trim().replace(/\s+/g, '_'),
      }))
      .on('headers', (headers) => {
        columnMap = buildColumnMap(headers);
        const mapped = Object.entries(columnMap).map(([k, v]) => `${k}→${v}`).join(', ');
        console.log(`[Ingestion] ${source} column map: ${mapped}`);

        // Feature 5: kick off drift detection concurrently — does not block the stream
        driftWarningsPromise = captureAndDiff(runId, source, headers).catch((err) => {
          console.error(`[SchemaDrift] Failed to capture drift for ${source}:`, err.message);
          return [];
        });
      })
      .on('data', async (rawRow) => {
        stream.pause();
        totalCount++;
        const rowIndex = totalCount;

        try {
          const doc = await processRow(rawRow, columnMap, runId, source, rowIndex);
          if (doc === null) {
            dlqCount++;
          } else {
            if (!doc.isValid) invalidCount++;
            batch.push(doc);
            if (batch.length >= BATCH_SIZE) await flushBatch();
          }
        } catch (unexpectedErr) {
          dlqCount++;
          await sendToDLQ({ runId, source, rawPayload: rawRow, rowIndex, error: unexpectedErr, failureStage: 'UNKNOWN' });
        }

        stream.resume();
      })
      .on('end', async () => {
        try {
          await flushBatch();
          const duplicates     = await flagDuplicates(runId, source);
          const driftWarnings  = await driftWarningsPromise; // Feature 5: await here
          invalidCount += duplicates;
          resolve({ total: totalCount, invalid: invalidCount, dlq: dlqCount, duplicates, driftWarnings });
        } catch (err) {
          reject(err);
        }
      })
      .on('error', (err) => {
        reject(new Error(`CSV stream error for ${source}: ${err.message}`));
      });
  });
};

module.exports = { ingestFile };
