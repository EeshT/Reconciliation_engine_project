const Transaction = require('../models/Transaction');
const ReconciliationResult = require('../models/ReconciliationResult');
const { typesMatch } = require('../utils/normalizer');

const BATCH_SIZE = 500;

// ── Helpers ───────────────────────────────────────────────────────────────────

const quantityDiffPct = (q1, q2) => {
  if (q1 === 0 && q2 === 0) return 0;
  if (q1 === 0) return Infinity;
  return Math.abs(q1 - q2) / Math.abs(q1);
};

const flushResults = async (batch) => {
  if (batch.length === 0) return;
  await ReconciliationResult.insertMany(batch, { ordered: false });
  batch.length = 0;
};

// ── Feature 1: Fee-Aware Quantity Check ───────────────────────────────────────

/**
 * Checks whether a quantity mismatch can be explained by a fee deduction.
 *
 * The pattern: user records the gross amount they intended to trade.
 * The exchange records the net amount after deducting its fee.
 * So: exchange_qty ≈ user_qty - exchange_fee
 *
 * We also check the reverse (exchange_qty - user_fee) because some CSVs
 * put the fee on the user side instead.
 *
 * @param {number} userQty
 * @param {number} exQty
 * @param {number|null} userFee
 * @param {number|null} exFee
 * @param {number} tolerancePct - The configured quantity tolerance
 * @returns {{ reconciled: boolean, feeDeducted: number|null, explanation: string|null }}
 */
const checkFeeReconciliation = (userQty, exQty, userFee, exFee, tolerancePct) => {
  // Try: user_qty - exchange_fee ≈ exchange_qty
  if (exFee !== null && exFee > 0) {
    const adjustedUserQty = userQty - exFee;
    if (quantityDiffPct(adjustedUserQty, exQty) <= tolerancePct) {
      return {
        reconciled:  true,
        feeDeducted: exFee,
        explanation: `exchange_fee=${exFee} deducted from user_qty=${userQty} → adjusted=${adjustedUserQty.toFixed(8)} ≈ exchange_qty=${exQty}`,
      };
    }
  }

  // Try: exchange_qty - user_fee ≈ user_qty  (fee recorded on user side)
  if (userFee !== null && userFee > 0) {
    const adjustedExQty = exQty - userFee;
    if (quantityDiffPct(userQty, adjustedExQty) <= tolerancePct) {
      return {
        reconciled:  true,
        feeDeducted: userFee,
        explanation: `user_fee=${userFee} deducted from exchange_qty=${exQty} → adjusted=${adjustedExQty.toFixed(8)} ≈ user_qty=${userQty}`,
      };
    }
  }

  // Try: the raw difference equals a known fee (either side is non-null)
  // This handles cases where neither CSV explicitly has a fee column but the
  // difference itself is small and plausible as a fee.
  const rawDiff = Math.abs(userQty - exQty);
  const knownFee = exFee ?? userFee;
  if (knownFee !== null && Math.abs(rawDiff - knownFee) / Math.max(userQty, 1) <= tolerancePct) {
    return {
      reconciled:  true,
      feeDeducted: knownFee,
      explanation: `quantity difference=${rawDiff.toFixed(8)} matches known fee=${knownFee}`,
    };
  }

  return { reconciled: false, feeDeducted: null, explanation: null };
};

// ── Feature 4: Multi-Pass Matching ────────────────────────────────────────────

/**
 * PASS 1 — Exact ID Match
 *
 * Before the sliding window runs, build an index of exchange transaction IDs.
 * Any user transaction whose ID appears in the exchange set is immediately paired.
 * This is the highest-confidence match possible — IDs are supposed to be unique
 * identifiers assigned by the exchange to a specific event.
 *
 * Complexity: O(N + M) — one pass each to build the index and consume user txs.
 *
 * @param {object[]} userTxs
 * @param {object[]} exchangeTxs
 * @param {Set} consumedExchangeIds - Mutated in-place to mark consumed exchanges
 * @param {string} runId
 * @param {object[]} resultsBatch - Mutated in-place
 * @returns {{ matched: number, remainingUserTxs: object[] }}
 */
const runPass1ExactId = (userTxs, exchangeTxs, consumedExchangeIds, runId, resultsBatch) => {
  // Index exchange txs by their normalized transaction ID
  const exchangeById = new Map();
  for (const ex of exchangeTxs) {
    const exId = ex.normalizedData?.id;
    if (exId) exchangeById.set(exId, ex);
  }

  let matched = 0;
  const remainingUserTxs = [];

  for (const userTx of userTxs) {
    const userId = userTx.normalizedData?.id;
    const exMatch = userId ? exchangeById.get(userId) : null;

    if (exMatch && !consumedExchangeIds.has(String(exMatch._id))) {
      consumedExchangeIds.add(String(exMatch._id));
      matched++;
      resultsBatch.push({
        runId,
        category:          'MATCHED',
        userTransaction:   userTx.rawRow,
        exchangeTransaction: exMatch.rawRow,
        matchPass:         'PASS_1_EXACT_ID',
        confidenceLevel:   'HIGH',
        feeDeducted:       null,
        reason: `Pass 1 (Exact ID): transaction_id="${userId}" found in both sources. ` +
                `asset=${userTx.normalizedData.asset}, qty=${userTx.normalizedData.quantity}.`,
      });
    } else {
      remainingUserTxs.push(userTx);
    }
  }

  return { matched, remainingUserTxs };
};

/**
 * PASS 2 & 3 — Sliding Window Matching
 *
 * Pass 2 uses the configured tolerances (strict).
 * Pass 3 uses 5× relaxed timestamp and quantity tolerances for transactions
 *         that didn't find a match in Pass 2. These are marked LOW confidence
 *         and flagged for human review.
 *
 * @param {object[]} userTxs - Only unmatched transactions from previous passes
 * @param {object[]} exchangeTxs - Full sorted exchange array
 * @param {Set} consumedExchangeIds - Mutated in-place
 * @param {string} runId
 * @param {object} config - { timestampToleranceMs, quantityTolerancePct }
 * @param {string} passName - 'PASS_2_STRICT' | 'PASS_3_RELAXED'
 * @param {string} confidenceLevel - 'MEDIUM' | 'LOW'
 * @param {object[]} resultsBatch - Mutated in-place
 * @returns {{ matched: number, feeMatched: number, conflicting: number, remainingUserTxs: object[] }}
 */
const runSlidingWindowPass = (
  userTxs, exchangeTxs, consumedExchangeIds,
  runId, config, passName, confidenceLevel, resultsBatch
) => {
  const { timestampToleranceMs, quantityTolerancePct } = config;

  let matched    = 0;
  let feeMatched = 0;
  let conflicting = 0;
  const remainingUserTxs = [];
  let leftPointer = 0;

  for (const userTx of userTxs) {
    const userTs     = userTx.normalizedData.timestampMs;
    const windowStart = userTs - timestampToleranceMs;
    const windowEnd   = userTs + timestampToleranceMs;

    while (
      leftPointer < exchangeTxs.length &&
      exchangeTxs[leftPointer].normalizedData.timestampMs < windowStart
    ) {
      leftPointer++;
    }

    const candidates = [];
    for (let i = leftPointer; i < exchangeTxs.length; i++) {
      const exTs = exchangeTxs[i].normalizedData.timestampMs;
      if (exTs > windowEnd) break;
      if (!consumedExchangeIds.has(String(exchangeTxs[i]._id))) {
        candidates.push(exchangeTxs[i]);
      }
    }

    let bestMatch     = null;
    let bestFeeMatch  = null; // Feature 1
    let bestConflict  = null;

    for (const candidate of candidates) {
      const assetMatch =
        userTx.normalizedData.asset &&
        candidate.normalizedData.asset &&
        userTx.normalizedData.asset === candidate.normalizedData.asset;

      const typeOk = typesMatch(userTx.normalizedData.type, candidate.normalizedData.type);
      if (!assetMatch || !typeOk) continue;

      const diffPct = quantityDiffPct(userTx.normalizedData.quantity, candidate.normalizedData.quantity);
      const tsDelta = Math.abs(userTx.normalizedData.timestampMs - candidate.normalizedData.timestampMs);

      if (diffPct <= quantityTolerancePct) {
        // Strict quantity match — prefer closest in time
        if (!bestMatch || tsDelta < Math.abs(userTx.normalizedData.timestampMs - bestMatch.normalizedData.timestampMs)) {
          bestMatch = candidate;
        }
      } else if (!bestMatch) {
        // Feature 1: quantity doesn't match — check if fee explains the gap
        const feeCheck = checkFeeReconciliation(
          userTx.normalizedData.quantity,
          candidate.normalizedData.quantity,
          userTx.normalizedData.fee,
          candidate.normalizedData.fee,
          quantityTolerancePct
        );

        if (feeCheck.reconciled) {
          if (!bestFeeMatch || tsDelta < Math.abs(userTx.normalizedData.timestampMs - bestFeeMatch.candidate.normalizedData.timestampMs)) {
            bestFeeMatch = { candidate, feeCheck };
          }
        } else {
          // Genuine conflict — track the closest mismatch
          if (!bestConflict || diffPct < quantityDiffPct(userTx.normalizedData.quantity, bestConflict.normalizedData.quantity)) {
            bestConflict = candidate;
          }
        }
      }
    }

    // ── Categorize ────────────────────────────────────────────────────────────
    if (bestMatch) {
      consumedExchangeIds.add(String(bestMatch._id));
      matched++;
      resultsBatch.push({
        runId,
        category:            'MATCHED',
        userTransaction:     userTx.rawRow,
        exchangeTransaction: bestMatch.rawRow,
        matchPass:           passName,
        confidenceLevel,
        feeDeducted:         null,
        reason: `${passName}: asset=${userTx.normalizedData.asset}, type=${userTx.normalizedData.type}↔${bestMatch.normalizedData.type}, ` +
                `qty_diff=${(quantityDiffPct(userTx.normalizedData.quantity, bestMatch.normalizedData.quantity) * 100).toFixed(4)}%, ` +
                `ts_diff=${Math.abs(userTx.normalizedData.timestampMs - bestMatch.normalizedData.timestampMs) / 1000}s.`,
      });
    } else if (bestFeeMatch) {
      // Feature 1: FEE_MATCHED — quantity reconciled after fee deduction
      consumedExchangeIds.add(String(bestFeeMatch.candidate._id));
      feeMatched++;
      resultsBatch.push({
        runId,
        category:            'FEE_MATCHED',
        userTransaction:     userTx.rawRow,
        exchangeTransaction: bestFeeMatch.candidate.rawRow,
        matchPass:           passName,
        confidenceLevel,
        feeDeducted:         bestFeeMatch.feeCheck.feeDeducted,
        reason: `${passName} (Fee-Reconciled): asset=${userTx.normalizedData.asset}, ` +
                `type=${userTx.normalizedData.type}↔${bestFeeMatch.candidate.normalizedData.type}. ` +
                `${bestFeeMatch.feeCheck.explanation}.`,
      });
    } else if (bestConflict) {
      consumedExchangeIds.add(String(bestConflict._id));
      conflicting++;
      const diffPct = quantityDiffPct(userTx.normalizedData.quantity, bestConflict.normalizedData.quantity);
      resultsBatch.push({
        runId,
        category:            'CONFLICTING',
        userTransaction:     userTx.rawRow,
        exchangeTransaction: bestConflict.rawRow,
        matchPass:           passName,
        confidenceLevel:     'LOW', // Conflicts are always low-confidence
        feeDeducted:         null,
        reason: `${passName}: Asset and type matched but quantity difference (${(diffPct * 100).toFixed(4)}%) ` +
                `exceeds tolerance of ${(quantityTolerancePct * 100).toFixed(4)}% and cannot be explained by a fee. ` +
                `user_qty=${userTx.normalizedData.quantity}, exchange_qty=${bestConflict.normalizedData.quantity}, ` +
                `user_fee=${userTx.normalizedData.fee ?? 'N/A'}, exchange_fee=${bestConflict.normalizedData.fee ?? 'N/A'}.`,
      });
    } else {
      remainingUserTxs.push(userTx);
    }
  }

  return { matched, feeMatched, conflicting, remainingUserTxs };
};

// ── Main Engine ───────────────────────────────────────────────────────────────

/**
 * MULTI-PASS RECONCILIATION ENGINE (Feature 4)
 *
 * Pass 1 — Exact ID match             → HIGH confidence, O(N+M)
 * Pass 2 — Sliding window, strict tol → MEDIUM confidence, O((N+M) log(N+M))
 * Pass 3 — Sliding window, 5× relaxed → LOW confidence, flagged for review
 *
 * Fee-aware quantity check (Feature 1) runs inside Pass 2 and Pass 3.
 *
 * @param {string} runId
 * @param {object} config
 * @returns {Promise<object>} Summary counts broken down by pass and confidence
 */
const runMatchingEngine = async (runId, config) => {
  const { timestampToleranceSeconds, quantityTolerancePct } = config;
  const timestampToleranceMs = timestampToleranceSeconds * 1000;

  const [userTxs, exchangeTxs] = await Promise.all([
    Transaction.find(
      { runId, source: 'USER', isValid: true },
      { normalizedData: 1, rawRow: 1 }
    ).sort({ 'normalizedData.timestampMs': 1 }).lean(),

    Transaction.find(
      { runId, source: 'EXCHANGE', isValid: true },
      { normalizedData: 1, rawRow: 1 }
    ).sort({ 'normalizedData.timestampMs': 1 }).lean(),
  ]);

  const consumedExchangeIds = new Set();
  const resultsBatch = [];

  let totalMatched    = 0;
  let totalFeeMatched = 0;
  let totalConflicting = 0;
  let matchedHigh     = 0;
  let matchedMedium   = 0;
  let matchedLow      = 0;

  // ── Pass 1: Exact ID ────────────────────────────────────────────────────────
  console.log(`[Run ${runId}] Pass 1: Exact ID matching...`);
  const pass1 = runPass1ExactId(userTxs, exchangeTxs, consumedExchangeIds, runId, resultsBatch);
  totalMatched += pass1.matched;
  matchedHigh  += pass1.matched;
  console.log(`[Run ${runId}] Pass 1 complete: ${pass1.matched} matched. ${pass1.remainingUserTxs.length} remaining.`);

  if (resultsBatch.length >= BATCH_SIZE) await flushResults(resultsBatch);

  // ── Pass 2: Strict sliding window ───────────────────────────────────────────
  console.log(`[Run ${runId}] Pass 2: Strict sliding window (ts=±${timestampToleranceSeconds}s, qty=±${quantityTolerancePct * 100}%)...`);
  const pass2 = runSlidingWindowPass(
    pass1.remainingUserTxs, exchangeTxs, consumedExchangeIds,
    runId,
    { timestampToleranceMs, quantityTolerancePct },
    'PASS_2_STRICT', 'MEDIUM',
    resultsBatch
  );
  totalMatched     += pass2.matched;
  totalFeeMatched  += pass2.feeMatched;
  totalConflicting += pass2.conflicting;
  matchedMedium    += pass2.matched + pass2.feeMatched;
  console.log(`[Run ${runId}] Pass 2 complete: ${pass2.matched} matched, ${pass2.feeMatched} fee-matched, ${pass2.conflicting} conflicting. ${pass2.remainingUserTxs.length} remaining.`);

  if (resultsBatch.length >= BATCH_SIZE) await flushResults(resultsBatch);

  // ── Pass 3: Relaxed sliding window ──────────────────────────────────────────
  const RELAXATION_FACTOR = 5;
  const relaxedTsMs  = timestampToleranceMs  * RELAXATION_FACTOR;
  const relaxedQtyPct = quantityTolerancePct * RELAXATION_FACTOR;
  console.log(`[Run ${runId}] Pass 3: Relaxed sliding window (ts=±${timestampToleranceSeconds * RELAXATION_FACTOR}s, qty=±${relaxedQtyPct * 100}%)...`);
  const pass3 = runSlidingWindowPass(
    pass2.remainingUserTxs, exchangeTxs, consumedExchangeIds,
    runId,
    { timestampToleranceMs: relaxedTsMs, quantityTolerancePct: relaxedQtyPct },
    'PASS_3_RELAXED', 'LOW',
    resultsBatch
  );
  totalMatched     += pass3.matched;
  totalFeeMatched  += pass3.feeMatched;
  totalConflicting += pass3.conflicting;
  matchedLow       += pass3.matched + pass3.feeMatched;
  console.log(`[Run ${runId}] Pass 3 complete: ${pass3.matched} matched, ${pass3.feeMatched} fee-matched, ${pass3.conflicting} conflicting. ${pass3.remainingUserTxs.length} unmatched.`);

  if (resultsBatch.length >= BATCH_SIZE) await flushResults(resultsBatch);

  // ── Unmatched user transactions ──────────────────────────────────────────────
  for (const userTx of pass3.remainingUserTxs) {
    resultsBatch.push({
      runId,
      category:            'UNMATCHED_USER',
      userTransaction:     userTx.rawRow,
      exchangeTransaction: null,
      matchPass:           null,
      confidenceLevel:     null,
      feeDeducted:         null,
      reason: `No exchange transaction found in any pass for asset=${userTx.normalizedData.asset}, type=${userTx.normalizedData.type}. ` +
              `Passes attempted: exact-ID, strict window (±${timestampToleranceSeconds}s), relaxed window (±${timestampToleranceSeconds * RELAXATION_FACTOR}s).`,
    });
    if (resultsBatch.length >= BATCH_SIZE) await flushResults(resultsBatch);
  }

  // ── Unmatched exchange transactions ─────────────────────────────────────────
  let unmatchedExchange = 0;
  for (const exTx of exchangeTxs) {
    if (!consumedExchangeIds.has(String(exTx._id))) {
      unmatchedExchange++;
      resultsBatch.push({
        runId,
        category:            'UNMATCHED_EXCHANGE',
        userTransaction:     null,
        exchangeTransaction: exTx.rawRow,
        matchPass:           null,
        confidenceLevel:     null,
        feeDeducted:         null,
        reason: `No user transaction found in any pass for asset=${exTx.normalizedData.asset}, type=${exTx.normalizedData.type}.`,
      });
      if (resultsBatch.length >= BATCH_SIZE) await flushResults(resultsBatch);
    }
  }

  await flushResults(resultsBatch);

  const unmatchedUser = pass3.remainingUserTxs.length;

  return {
    matched:          totalMatched,
    feeMatched:       totalFeeMatched,
    conflicting:      totalConflicting,
    unmatchedUser,
    unmatchedExchange,
    matchedHigh,
    matchedMedium,
    matchedLow,
  };
};

module.exports = { runMatchingEngine };
