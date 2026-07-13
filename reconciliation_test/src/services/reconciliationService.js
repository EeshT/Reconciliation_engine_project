const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const config = require('../config');
const ReconciliationRun = require('../models/ReconciliationRun');
const { ingestFile } = require('./ingestionService');
const { runMatchingEngine } = require('./matchingService');

const startReconciliation = async (userFilePath, exchangeFilePath, configOverrides = {}) => {
  const runId = uuidv4();

  const runConfig = {
    timestampToleranceSeconds:
      configOverrides.timestampToleranceSeconds ?? config.defaults.timestampToleranceSeconds,
    quantityTolerancePct:
      configOverrides.quantityTolerancePct ?? config.defaults.quantityTolerancePct,
  };

  await ReconciliationRun.create({ runId, status: 'PENDING', config: runConfig });

  _executeRun(runId, userFilePath, exchangeFilePath, runConfig).catch((err) => {
    console.error(`[Reconciliation] Run ${runId} failed unexpectedly:`, err.message);
  });

  return runId;
};

const _executeRun = async (runId, userFilePath, exchangeFilePath, runConfig) => {
  try {
    await ReconciliationRun.findOneAndUpdate({ runId }, { status: 'PROCESSING' });
    console.log(`[Run ${runId}] Status: PROCESSING`);

    // Stage 1: Ingest (now returns driftWarnings from Feature 5)
    console.log(`[Run ${runId}] Starting ingestion...`);
    const [userIngestion, exchangeIngestion] = await Promise.all([
      ingestFile(userFilePath, 'USER', runId),
      ingestFile(exchangeFilePath, 'EXCHANGE', runId),
    ]);
    console.log(
      `[Run ${runId}] Ingestion complete. ` +
      `User: ${userIngestion.total} rows (${userIngestion.invalid} invalid, ${userIngestion.dlq} DLQ). ` +
      `Exchange: ${exchangeIngestion.total} rows (${exchangeIngestion.invalid} invalid, ${exchangeIngestion.dlq} DLQ).`
    );

    // Feature 5: Collect all drift warnings from both sources and save on the run
    const allDriftWarnings = [
      ...(userIngestion.driftWarnings || []),
      ...(exchangeIngestion.driftWarnings || []),
    ];
    if (allDriftWarnings.length > 0) {
      await ReconciliationRun.findOneAndUpdate({ runId }, { schemaDriftWarnings: allDriftWarnings });
      console.warn(`[Run ${runId}] Schema drift detected! ${allDriftWarnings.length} warning(s).`);
    }

    // Stage 2: Match (now returns feeMatched + confidence breakdown from Features 1 & 4)
    console.log(`[Run ${runId}] Starting multi-pass matching engine...`);
    const matchingSummary = await runMatchingEngine(runId, runConfig);
    console.log(`[Run ${runId}] Matching complete.`, matchingSummary);

    // Stage 3: Persist complete summary
    await ReconciliationRun.findOneAndUpdate(
      { runId },
      {
        status: 'COMPLETED',
        summary: {
          totalUser:          userIngestion.total,
          totalExchange:      exchangeIngestion.total,
          invalidUser:        userIngestion.invalid,
          invalidExchange:    exchangeIngestion.invalid,
          dlqUser:            userIngestion.dlq,
          dlqExchange:        exchangeIngestion.dlq,
          duplicatesUser:     userIngestion.duplicates,
          duplicatesExchange: exchangeIngestion.duplicates,
          matched:            matchingSummary.matched,
          feeMatched:         matchingSummary.feeMatched,       // Feature 1
          conflicting:        matchingSummary.conflicting,
          unmatchedUser:      matchingSummary.unmatchedUser,
          unmatchedExchange:  matchingSummary.unmatchedExchange,
          matchedHigh:        matchingSummary.matchedHigh,      // Feature 4
          matchedMedium:      matchingSummary.matchedMedium,
          matchedLow:         matchingSummary.matchedLow,
        },
      }
    );
    console.log(`[Run ${runId}] Status: COMPLETED`);
  } catch (error) {
    console.error(`[Run ${runId}] Fatal error:`, error.message);
    await ReconciliationRun.findOneAndUpdate(
      { runId },
      { status: 'FAILED', errorMessage: error.message }
    );
  } finally {
    [userFilePath, exchangeFilePath].forEach((fp) => {
      if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
    });
  }
};

module.exports = { startReconciliation };
