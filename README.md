A production-grade Node.js service that ingests transaction data from two sources (user-exported and exchange-exported), matches them using an efficient sliding window algorithm, and produces a structured reconciliation report via a REST API.

---

## Table of Contents

1. [Tech Stack](#tech-stack)
2. [Project Structure](#project-structure)
3. [Setup & Installation](#setup--installation)
4. [API Reference](#api-reference)
5. [Configuration](#configuration)
6. [Design Decisions](#design-decisions)
7. [Known Edge Cases Handled](#known-edge-cases-handled)
8. [Version Control Strategy](#version-control-strategy)

---

## Tech Stack

| Layer | Technology | Rationale |
|---|---|---|
| Runtime | Node.js (≥18) | Async I/O suits long-running streaming ingestion |
| Framework | Express.js | Minimal, stable, ideal for REST APIs |
| Database | MongoDB + Mongoose | Flexible schema handles messy, variable CSV structures |
| CSV Parsing | csv-parser | Stream-based — never loads full file into memory |
| Validation | Zod | Type-safe schema validation with clear error messages |
| File Upload | Multer | Industry-standard multipart form handler |
| IDs | uuid | Collision-resistant run IDs |

---

## Project Structure

```
src/
├── config/
│   └── index.js                  # Environment variable loading & defaults
├── controllers/
│   └── reconciliationController.js  # HTTP layer: request parsing, response formatting
├── middlewares/
│   ├── upload.js                 # Multer CSV-only file upload handler
│   └── errorHandler.js           # Global error classifier (operational vs programmer)
├── models/
│   ├── ReconciliationRun.js      # Job lifecycle, config, and summary counts
│   ├── Transaction.js            # Ingested rows from both CSV sources
│   ├── ReconciliationResult.js   # Categorized match outcomes
│   └── DeadLetterQueue.js        # Rows that caused unhandled exceptions
├── routes/
│   └── reconciliationRoutes.js   # Express route definitions
├── services/
│   ├── ingestionService.js       # Streaming CSV parser, column mapping, validation, DLQ
│   ├── matchingService.js        # Sliding window matching algorithm
│   └── reconciliationService.js  # Orchestrates ingestion → matching → summary
├── utils/
│   ├── db.js                     # MongoDB connection
│   ├── normalizer.js             # Fuzzy asset matcher (Levenshtein), type mapping
│   └── AppError.js               # Operational error class
├── app.js                        # Express app setup and middleware wiring
└── index.js                      # Server entry point with graceful shutdown
sample_data/
├── user_transactions.csv         # Example user CSV for local testing
└── exchange_transactions.csv     # Example exchange CSV for local testing
```

---

## Setup & Installation

### Prerequisites

- Node.js ≥ 18
- MongoDB running locally or a MongoDB Atlas connection string

### Steps

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd reconciliation-engine

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
# Edit .env with your MongoDB URI and any tolerance overrides

# 4. Start the server
npm start

# For development with auto-reload:
npm run dev
```

The server starts on `http://localhost:3000` by default.

---

## CSV File Format

Both files must be CSV with the following logical fields. **Column header names are flexible** — the engine resolves common variants automatically (see Design Decision #9).

| Logical Field | Accepted Header Names |
|---|---|
| Transaction ID | `id`, `transaction_id`, `tx_id`, `txid`, `transaction_hash`, `hash`, `ref` |
| Timestamp | `timestamp`, `date`, `datetime`, `time`, `created_at`, `trade_time`, `ts` |
| Asset | `asset`, `coin`, `currency`, `symbol`, `ticker`, `crypto` |
| Type | `type`, `transaction_type`, `tx_type`, `side`, `action`, `direction` |
| Quantity | `quantity`, `amount`, `qty`, `volume`, `size`, `units` |

Any additional columns (e.g. `price_usd`, `fee`, `note`) are stored as-is in `rawRow` and included in report output. Extra columns never cause failures.

---

## API Reference

### `POST /reconcile`

Triggers a new reconciliation run. Returns immediately with a `runId` — processing runs in the background.

**Request:** `multipart/form-data`

| Field | Type | Description |
|---|---|---|
| `userFile` | File (CSV) | User-exported transaction CSV |
| `exchangeFile` | File (CSV) | Exchange-exported transaction CSV |
| `timestampToleranceSeconds` | Number (optional) | Override default time window for this run |
| `quantityTolerancePct` | Number (optional) | Override default quantity tolerance (0–1) for this run |

**Response `202 Accepted`:**
```json
{
  "success": true,
  "runId": "550e8400-e29b-41d4-a716-446655440000",
  "message": "Reconciliation run started. Poll GET /report/:runId/summary for status updates."
}
```

---

### `GET /report/:runId/summary`

Poll for run status and high-level counts. The `status` field transitions: `PENDING → PROCESSING → COMPLETED` (or `FAILED`).

**Response `200`:**
```json
{
  "success": true,
  "runId": "550e8400-...",
  "status": "COMPLETED",
  "config": {
    "timestampToleranceSeconds": 300,
    "quantityTolerancePct": 0.01
  },
  "summary": {
    "totalUser": 26,
    "totalExchange": 25,
    "invalidUser": 3,
    "invalidExchange": 0,
    "dlqUser": 0,
    "dlqExchange": 0,
    "duplicatesUser": 1,
    "duplicatesExchange": 0,
    "matched": 20,
    "conflicting": 1,
    "unmatchedUser": 1,
    "unmatchedExchange": 2
  },
  "startedAt": "2024-03-01T10:00:00.000Z",
  "completedAt": "2024-03-01T10:00:04.231Z"
}
```

**Summary field glossary:**

| Field | Meaning |
|---|---|
| `totalUser` / `totalExchange` | Total rows parsed from each CSV |
| `invalidUser` / `invalidExchange` | Rows that failed validation (bad timestamp, missing field, negative quantity, etc.) — flagged with `isValid: false`, never silently dropped |
| `dlqUser` / `dlqExchange` | Rows that caused **unhandled exceptions** during parsing — routed to the Dead Letter Queue for developer inspection |
| `duplicatesUser` / `duplicatesExchange` | Rows with a duplicate `transaction_id` — only the first occurrence is matched, duplicates marked invalid |
| `matched` | Pairs successfully reconciled across both sources |
| `conflicting` | Pairs where asset/type/timestamp matched but quantity exceeded tolerance |
| `unmatchedUser` | Rows in user file with no exchange counterpart |
| `unmatchedExchange` | Rows in exchange file with no user counterpart |

---

### `GET /report/:runId`

Full paginated report with all categorized result rows.

**Query params:** `page` (default: 1), `limit` (default: 100, max: 500)

**Response `200`:**
```json
{
  "success": true,
  "runId": "550e8400-...",
  "status": "COMPLETED",
  "config": { ... },
  "pagination": { "page": 1, "limit": 100, "totalCount": 245, "totalPages": 3 },
  "results": [
    {
      "runId": "550e8400-...",
      "category": "MATCHED",
      "userTransaction": { "transaction_id": "USR-001", "asset": "BTC", ... },
      "exchangeTransaction": { "transaction_id": "EXC-1001", "asset": "BTC", ... },
      "reason": "Matched on asset=BTC, type=BUY↔BUY, quantity diff=0.0000%, timestamp diff=32s"
    }
  ]
}
```

Result categories:

| Category | Meaning |
|---|---|
| `MATCHED` | Paired successfully — all fields within tolerance |
| `CONFLICTING` | Asset, type, and timestamp matched but quantity exceeded tolerance |
| `UNMATCHED_USER` | Present in user file, no exchange counterpart found |
| `UNMATCHED_EXCHANGE` | Present in exchange file, no user counterpart found |

---

### `GET /report/:runId/unmatched`

Returns only `UNMATCHED_USER` and `UNMATCHED_EXCHANGE` rows with reasons.

**Query params:** `page`, `limit`

---

### `GET /report/:runId/dlq`

Returns Dead Letter Queue entries — rows that caused **unhandled exceptions** during parsing. These require developer investigation, not data-team review.

**Query params:**
- `resolved=true` / `resolved=false` — filter by resolution status (omit for all)
- `page`, `limit` (default: 50, max: 200)

**Response `200`:**
```json
{
  "success": true,
  "runId": "550e8400-...",
  "note": "DLQ entries are rows that caused unhandled exceptions and require developer review.",
  "dlqSummary": { "dlqUser": 1, "dlqExchange": 0 },
  "pagination": { ... },
  "entries": [
    {
      "runId": "550e8400-...",
      "source": "USER",
      "rawPayload": { "transaction_id": "USR-999", ... },
      "rowIndex": 14,
      "errorMessage": "Cannot read properties of null (reading 'toLowerCase')",
      "errorStack": "TypeError: ...",
      "failureStage": "ASSET_NORMALIZE",
      "resolved": false,
      "resolutionNote": null
    }
  ]
}
```

**Failure stages:**

| Stage | Description |
|---|---|
| `KEY_NORMALIZATION` | Exception while mapping CSV column headers to canonical names |
| `SCHEMA_VALIDATION` | Zod threw unexpectedly (not a validation failure — those go to `isValid: false`) |
| `TIMESTAMP_PARSE` | Unhandled exception inside `parseTimestamp()` |
| `QUANTITY_PARSE` | Unhandled exception inside `parseQuantity()` |
| `ASSET_NORMALIZE` | Unhandled exception inside the Levenshtein normalizer |
| `DB_INSERT` | MongoDB `insertMany()` rejected a specific document |
| `UNKNOWN` | Exception caught by the outermost safety net in the stream handler |

---

### `PATCH /report/:runId/dlq/:entryId/resolve`

Marks a DLQ entry as reviewed and resolved.

**Request body:**
```json
{ "note": "Investigated — malformed encoding from legacy exporter v1.2. Fixed upstream." }
```

**Response `200`:**
```json
{ "success": true, "entry": { "resolved": true, "resolutionNote": "...", ... } }
```

---

### `GET /health`

Basic liveness check.

**Response `200`:**
```json
{ "status": "ok", "timestamp": "2024-03-01T10:00:00.000Z" }
```

---

## Configuration

All tolerances are configurable without code changes via environment variables or per-run request body overrides.

| Variable | Default | Description |
|---|---|---|
| `TIMESTAMP_TOLERANCE_SECONDS` | `300` | Max seconds between two transactions to be considered a potential match |
| `QUANTITY_TOLERANCE_PCT` | `0.01` | Max fractional quantity difference to accept as matched (0.01 = 1%) |
| `MONGODB_URI` | `mongodb://localhost:27017/reconciliation_engine` | MongoDB connection string |
| `PORT` | `3000` | HTTP server port |
| `MAX_FILE_SIZE_MB` | `50` | Maximum uploaded CSV file size |

Per-run overrides sent in the `POST /reconcile` body take precedence over `.env` values for that specific run. The exact config used is persisted on the `ReconciliationRun` document for full auditability.

---

## Design Decisions

### 1. Asynchronous Run Model (Fire-and-Forget)

**Decision:** `POST /reconcile` returns `202 Accepted` immediately with a `runId`. Processing runs in the background via an unawaited async function.

**Rationale:** Reconciling large files can take seconds to minutes. A synchronous approach would cause HTTP timeouts at the load balancer or client level. The polling model (`GET /report/:runId/summary`) decouples submission from completion and scales naturally to job queues if needed in future.

---

### 2. Sliding Window Matching Algorithm (O(N log N))

**Decision:** Both transaction arrays are sorted chronologically, then a two-pointer technique constrains the comparison pool to only the candidates within `TIMESTAMP_TOLERANCE_SECONDS`.

**Rationale:** A naive nested loop is O(N×M) — 10 billion comparisons for 100k transactions on each side. Sorting first costs O(N log N), and the sliding window then makes the inner loop O(N+M) in the average case, bringing the total to O((N+M) log(N+M)).

**Conflict resolution within the window:** When multiple exchange candidates qualify by time, asset, and type, the engine picks the one with the smallest absolute timestamp delta. This prevents arbitrary pairing when two similar transactions are close together.

**Match consumption:** A matched exchange transaction is added to a `Set` and excluded from all subsequent user transaction comparisons, preventing any exchange row from being double-matched.

---

### 3. Non-Destructive Row Flagging

**Decision:** Rows with data quality issues are stored in MongoDB with `isValid: false` and a `validationErrors` string array. They are never silently dropped.

**Rationale:** In a financial audit, every input row must be accounted for. Silent drops mask data corruption and make reconciliation results unverifiable. The `invalidUser`/`invalidExchange` counts in the summary make data quality immediately visible.

---

### 4. Dead Letter Queue (DLQ) — Two-Tier Error Handling

**Decision:** The system distinguishes between two categories of bad rows, stored in separate places:

| Tier | Storage | Who reviews it | Example |
|---|---|---|---|
| **Invalid row** (`isValid: false`) | `transactions` collection | Data team / end user | Missing timestamp, wrong format |
| **DLQ entry** | `deadletterqueues` collection | Developer | `null.toLowerCase()` crash, DB write error |

Every stage of `processRow()` is wrapped in its own `try/catch` tagged with a `failureStage` enum. A final outer catch in the stream handler is an absolute safety net — a single malformed row can never kill the stream or fail the entire run.

**Rationale:** Mixing these two categories into one place conflates data quality problems (fix the source data) with engineering problems (fix the parser code). Separating them makes root cause analysis faster and prevents false-positive `invalidUser` counts from obscuring real bugs.

---

### 5. Fuzzy Asset Matching (Levenshtein Distance)

**Decision:** Asset normalization uses a three-pass resolver:

1. **Exact alias lookup** — O(1) dictionary check covering 60+ known aliases (`"bitcoin" → BTC`, `"ether" → ETH`, `"xbt" → BTC`, etc.)
2. **Levenshtein fuzzy match** — compares against both canonical tickers (`BTC`, `ETH`) and full alias keys (`"ethereum"`, `"dogecoin"`) using normalized similarity. Accepts matches ≥ 0.75 similarity score.
3. **Fallback** — uppercases the raw input and stores it as-is. Unknown assets are preserved, not silently mapped wrong.

The similarity score, resolution method (`exact` / `fuzzy` / `fallback`), and original raw input are all stored on the `Transaction` document for full auditability.

**Implementation:** Pure Levenshtein using the two-row rolling array technique (O(min(m,n)) space, O(m×n) time per comparison). No external dependency.

**Threshold:** The 0.75 similarity floor prevents false-positive mappings between short, dissimilar tickers. Configurable in `normalizer.js` via `FUZZY_SIMILARITY_THRESHOLD`.

---

### 6. Streaming Ingestion with Back-Pressure

**Decision:** CSV files are parsed as Node.js Readable streams via `csv-parser`. The stream is explicitly `pause()`-d before each async DB operation and `resume()`-d afterward.

**Rationale:** Loading a large CSV entirely into memory would exhaust the heap. Stream-based parsing keeps memory usage constant O(batch_size) regardless of file size. Back-pressure prevents the stream from racing ahead of the database writes and creating an unbounded in-memory queue.

---

### 7. Batch Database Inserts

**Decision:** Parsed, validated rows accumulate in a local array and are flushed to MongoDB in batches of 500 using `insertMany({ ordered: false })`.

**Rationale:** One DB round-trip per row would be catastrophically slow. Batching reduces this to N/500 round trips. The `ordered: false` flag means MongoDB continues inserting the rest of the batch even if one document fails — those individual failures are caught and routed to the DLQ rather than aborting the batch.

---

### 8. Four-Collection MongoDB Schema

The system uses four separate collections, each with a single responsibility:

| Collection | Purpose | Key Indexes |
|---|---|---|
| `reconciliationruns` | Job lifecycle, config used, final summary counts | `runId` (unique) |
| `transactions` | All ingested rows from both sources, raw + normalized | `(runId, source, isValid)`, `(runId, timestampMs)` |
| `reconciliationresults` | Categorized match outcomes | `(runId, category)` |
| `deadletterqueues` | Rows that caused unhandled exceptions | `(runId, resolved)`, `(runId, source)` |

**Rationale:** Mixing these into one document would make querying and pagination impractical. Separate collections allow each to be indexed independently. The compound index on `(runId, source, isValid)` means the matching engine's bulk read only scans valid rows for the current run, never the entire collection.

---

### 9. Flexible Column Name Mapping

**Decision:** Rather than requiring exact CSV header names, the ingestion layer resolves headers using a priority-list alias map at parse time (via the `headers` event on the csv-parser stream).

```
"transaction_id" → id
"tx_id"          → id
"txid"           → id
```

The resolved mapping is logged at the start of each ingestion for debuggability.

**Rationale:** Real-world CSV exports from different exchanges and portfolio trackers use wildly inconsistent column names for the same logical field. Requiring exact headers forces users to pre-process their files — the engine should absorb this variability instead.

---

### 10. Tolerances Persisted Per-Run

**Decision:** The `ReconciliationRun` document stores the exact `timestampToleranceSeconds` and `quantityTolerancePct` values used for that run.

**Rationale:** If a reconciliation result is queried weeks later for audit purposes, the reviewer must be able to reproduce exactly how the matching decisions were made. Relying only on environment variables makes past runs non-reproducible if the config changes.

---

### 11. Duplicate Transaction ID Detection

**Decision:** After ingestion, `flagDuplicates()` queries all valid transactions for the run, sorted by insertion order. Any row whose `transaction_id` was already seen gets marked `isValid: false` with an explicit reason string. Only the first occurrence is eligible for matching.

**Rationale:** Duplicate rows in user-exported CSV files are common (copy-paste errors, double exports). Without detection, a duplicate would consume an exchange match, leaving the legitimate later occurrence unmatched and producing a misleading `UNMATCHED_USER` result. The `duplicatesUser`/`duplicatesExchange` fields in the summary surface this separately from data quality invalids.

---

### 12. Negative Quantity Rejection

**Decision:** `parseQuantity()` explicitly rejects values less than zero, returning a validation error rather than storing the negative number.

**Rationale:** In this domain, a negative quantity is always a data error. A sale is represented by `type=SELL` with a positive quantity — not a negative BUY. Allowing negatives into the matching engine would produce incorrect quantity difference calculations and potential ghost matches.

---

## Known Edge Cases Handled

| Scenario | How it's handled |
|---|---|
| `"bitcoin"` vs `"BTC"` vs `"ether"` | Exact alias dictionary, then Levenshtein fuzzy match |
| `"etherium"` (misspelling) | Fuzzy match → ETH (similarity 0.875) |
| `TRANSFER_OUT` (user) vs `TRANSFER_IN` (exchange) | `TYPE_COUNTERPARTS` map treats these as a valid pair |
| Malformed timestamp (`"2024-03-09T"`) | Explicit regex guard rejects incomplete ISO strings |
| Negative quantity (`-0.10`) | Rejected at parse time with descriptive error |
| Duplicate `transaction_id` in same file | Post-ingestion deduplication; only first occurrence matched |
| Extra columns (`fee`, `price_usd`, `note`) | Stored in `rawRow`; never cause failures |
| Mixed header casing (`Transaction_ID`, `TIMESTAMP`) | `mapHeaders` lowercases all headers before alias resolution |
| Batch DB insert partial failure | Failed documents individually routed to DLQ; rest of batch continues |
| Stream-level CSV parse error | Rejects the entire file with a clear error on the run record |
| Unknown asset ticker (`XYZCOIN999`) | Fallback to uppercased raw input; stored without fuzzy mapping |

---


