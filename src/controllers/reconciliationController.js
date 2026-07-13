const { z } = require('zod');
const ReconciliationRun = require('../models/ReconciliationRun');
const ReconciliationResult = require('../models/ReconciliationResult');
const DeadLetterQueue = require('../models/DeadLetterQueue');
const { startReconciliation } = require('../services/reconciliationService');
const { getDriftLogsForRun } = require('../services/schemaDriftService'); // Feature 5
const AppError = require('../utils/AppError');

const configOverrideSchema = z.object({
  timestampToleranceSeconds: z.coerce.number().positive().optional(),
  quantityTolerancePct:      z.coerce.number().positive().max(1).optional(),
});

// ── Core endpoints ────────────────────────────────────────────────────────────

const triggerReconciliation = async (req, res, next) => {
  try {
    if (!req.files?.userFile?.[0] || !req.files?.exchangeFile?.[0]) {
      throw new AppError('Both userFile and exchangeFile CSV uploads are required.', 400);
    }
    const configParse = configOverrideSchema.safeParse(req.body);
    if (!configParse.success) {
      throw new AppError(
        `Invalid config parameters: ${configParse.error.errors.map((e) => e.message).join(', ')}`,
        400
      );
    }
    const runId = await startReconciliation(
      req.files.userFile[0].path,
      req.files.exchangeFile[0].path,
      configParse.data
    );
    return res.status(202).json({
      success: true,
      runId,
      message: 'Reconciliation run started. Poll GET /report/:runId/summary for status updates.',
    });
  } catch (err) { next(err); }
};

const getFullReport = async (req, res, next) => {
  try {
    const { runId } = req.params;
    const page  = parseInt(req.query.page,  10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const skip  = (page - 1) * limit;

    // Feature 4: optional filter by confidence level
    const confidenceFilter = req.query.confidence
      ? { confidenceLevel: req.query.confidence.toUpperCase() }
      : {};

    // Feature 1: optional filter by category (e.g. ?category=FEE_MATCHED)
    const categoryFilter = req.query.category
      ? { category: req.query.category.toUpperCase() }
      : {};

    const run = await ReconciliationRun.findOne({ runId }).lean();
    if (!run) throw new AppError(`No run found with ID: ${runId}`, 404);

    const query = { runId, ...confidenceFilter, ...categoryFilter };
    const [results, totalCount] = await Promise.all([
      ReconciliationResult.find(query, { _id: 0, __v: 0, createdAt: 0, updatedAt: 0 })
        .skip(skip).limit(limit).lean(),
      ReconciliationResult.countDocuments(query),
    ]);

    return res.json({
      success: true,
      runId,
      status: run.status,
      config: run.config,
      schemaDriftWarnings: run.schemaDriftWarnings, // Feature 5
      pagination: { page, limit, totalCount, totalPages: Math.ceil(totalCount / limit) },
      results,
    });
  } catch (err) { next(err); }
};

const getReportSummary = async (req, res, next) => {
  try {
    const { runId } = req.params;
    const run = await ReconciliationRun.findOne(
      { runId },
      { runId: 1, status: 1, config: 1, summary: 1, schemaDriftWarnings: 1, errorMessage: 1, createdAt: 1, updatedAt: 1 }
    ).lean();
    if (!run) throw new AppError(`No run found with ID: ${runId}`, 404);

    return res.json({
      success: true,
      runId: run.runId,
      status: run.status,
      config: run.config,
      summary: run.summary,
      schemaDriftWarnings: run.schemaDriftWarnings, // Feature 5
      errorMessage: run.errorMessage || undefined,
      startedAt:    run.createdAt,
      completedAt:  run.status === 'COMPLETED' ? run.updatedAt : undefined,
    });
  } catch (err) { next(err); }
};

const getUnmatchedReport = async (req, res, next) => {
  try {
    const { runId } = req.params;
    const page  = parseInt(req.query.page,  10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const skip  = (page - 1) * limit;

    const run = await ReconciliationRun.findOne({ runId }, { status: 1 }).lean();
    if (!run) throw new AppError(`No run found with ID: ${runId}`, 404);

    const query = { runId, category: { $in: ['UNMATCHED_USER', 'UNMATCHED_EXCHANGE'] } };
    const [results, totalCount] = await Promise.all([
      ReconciliationResult.find(query, { _id: 0, __v: 0, createdAt: 0, updatedAt: 0 })
        .skip(skip).limit(limit).lean(),
      ReconciliationResult.countDocuments(query),
    ]);

    return res.json({
      success: true,
      runId,
      status: run.status,
      pagination: { page, limit, totalCount, totalPages: Math.ceil(totalCount / limit) },
      results,
    });
  } catch (err) { next(err); }
};

// ── DLQ endpoints ─────────────────────────────────────────────────────────────

const getDLQEntries = async (req, res, next) => {
  try {
    const { runId } = req.params;
    const page  = parseInt(req.query.page,  10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip  = (page - 1) * limit;
    const resolvedFilter = req.query.resolved !== undefined
      ? { resolved: req.query.resolved === 'true' } : {};

    const run = await ReconciliationRun.findOne({ runId }, { status: 1, summary: 1 }).lean();
    if (!run) throw new AppError(`No run found with ID: ${runId}`, 404);

    const query = { runId, ...resolvedFilter };
    const [entries, totalCount] = await Promise.all([
      DeadLetterQueue.find(query, { __v: 0 }).skip(skip).limit(limit).lean(),
      DeadLetterQueue.countDocuments(query),
    ]);

    return res.json({
      success: true,
      runId,
      note: 'DLQ entries are rows that caused unhandled exceptions and require developer review.',
      dlqSummary: { dlqUser: run.summary?.dlqUser ?? 0, dlqExchange: run.summary?.dlqExchange ?? 0 },
      pagination: { page, limit, totalCount, totalPages: Math.ceil(totalCount / limit) },
      entries,
    });
  } catch (err) { next(err); }
};

const resolveDLQEntry = async (req, res, next) => {
  try {
    const { runId, entryId } = req.params;
    const { note } = req.body;
    const entry = await DeadLetterQueue.findOneAndUpdate(
      { _id: entryId, runId },
      { resolved: true, resolutionNote: note || null },
      { new: true }
    );
    if (!entry) throw new AppError(`DLQ entry not found: ${entryId}`, 404);
    return res.json({ success: true, entry });
  } catch (err) { next(err); }
};

// ── Feature 5: Schema drift endpoint ──────────────────────────────────────────

/**
 * GET /report/:runId/schema-drift
 * Returns the schema drift logs for both sources in this run.
 * Shows current headers, previous headers, and exactly what changed.
 */
const getSchemaDrift = async (req, res, next) => {
  try {
    const { runId } = req.params;
    const run = await ReconciliationRun.findOne(
      { runId },
      { status: 1, schemaDriftWarnings: 1 }
    ).lean();
    if (!run) throw new AppError(`No run found with ID: ${runId}`, 404);

    const logs = await getDriftLogsForRun(runId);

    return res.json({
      success: true,
      runId,
      status: run.status,
      driftDetected: run.schemaDriftWarnings?.length > 0,
      warnings: run.schemaDriftWarnings,
      logs, // Full detail: added/removed/renamed columns per source
    });
  } catch (err) { next(err); }
};

module.exports = {
  triggerReconciliation,
  getFullReport,
  getReportSummary,
  getUnmatchedReport,
  getDLQEntries,
  resolveDLQEntry,
  getSchemaDrift,
};
