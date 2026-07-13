const { Router } = require('express');
const upload = require('../middlewares/upload');
const {
  triggerReconciliation,
  getFullReport,
  getReportSummary,
  getUnmatchedReport,
  getDLQEntries,
  resolveDLQEntry,
  getSchemaDrift,
} = require('../controllers/reconciliationController');

const router = Router();

/** POST /reconcile — trigger a new run */
router.post(
  '/reconcile',
  upload.fields([
    { name: 'userFile',     maxCount: 1 },
    { name: 'exchangeFile', maxCount: 1 },
  ]),
  triggerReconciliation
);

/**
 * GET /report/:runId
 * Full paginated report.
 * Optional query filters:
 *   ?category=FEE_MATCHED   
 *   ?confidence=HIGH|MEDIUM|LOW  
 */
router.get('/report/:runId', getFullReport);

/** GET /report/:runId/summary — status + full count breakdown */
router.get('/report/:runId/summary', getReportSummary);

/** GET /report/:runId/unmatched — unmatched rows from both sides */
router.get('/report/:runId/unmatched', getUnmatchedReport);

/** GET /report/:runId/dlq — dead letter queue entries */
router.get('/report/:runId/dlq', getDLQEntries);

/** PATCH /report/:runId/dlq/:entryId/resolve — mark DLQ entry resolved */
router.patch('/report/:runId/dlq/:entryId/resolve', resolveDLQEntry);

/**
 * GET /report/:runId/schema-drift   
 * Returns header snapshots for both sources and a diff vs the previous run.
 */
router.get('/report/:runId/schema-drift', getSchemaDrift);

module.exports = router;
