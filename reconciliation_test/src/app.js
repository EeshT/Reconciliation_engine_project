const express = require('express');
const reconciliationRoutes = require('./routes/reconciliationRoutes');
const errorHandler = require('./middlewares/errorHandler');
const AppError = require('./utils/AppError');

const app = express();

// Parse JSON and URL-encoded bodies (for config overrides sent with the file upload)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Mount all reconciliation routes
app.use('/', reconciliationRoutes);

// Handle unknown routes
app.all('*', (req, _res, next) => {
  next(new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404));
});

// Global error handler — must be last
app.use(errorHandler);

module.exports = app;
