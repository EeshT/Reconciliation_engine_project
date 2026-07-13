require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT, 10) || 3000,
  mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/reconciliation_engine',
  nodeEnv: process.env.NODE_ENV || 'development',
  defaults: {
    timestampToleranceSeconds: parseFloat(process.env.TIMESTAMP_TOLERANCE_SECONDS) || 300,
    quantityTolerancePct: parseFloat(process.env.QUANTITY_TOLERANCE_PCT) || 0.01,
  },
  upload: {
    maxFileSizeMb: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 50,
  },
};

module.exports = config;
