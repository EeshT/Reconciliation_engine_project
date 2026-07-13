const app = require('./app');
const connectDB = require('./utils/db');
const config = require('./config');

const startServer = async () => {
  await connectDB();

  const server = app.listen(config.port, () => {
    console.log(`[Server] Running in ${config.nodeEnv} mode on port ${config.port}`);
    console.log(`[Server] Default tolerances: timestamp=±${config.defaults.timestampToleranceSeconds}s, quantity=±${config.defaults.quantityTolerancePct * 100}%`);
  });

  // Graceful shutdown on SIGTERM (e.g., from Docker or process managers)
  process.on('SIGTERM', () => {
    console.log('[Server] SIGTERM received. Shutting down gracefully...');
    server.close(() => {
      console.log('[Server] HTTP server closed.');
      process.exit(0);
    });
  });

  // Handle uncaught exceptions to prevent zombie processes
  process.on('uncaughtException', (err) => {
    console.error('[Process] Uncaught Exception:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[Process] Unhandled Promise Rejection:', reason);
    server.close(() => process.exit(1));
  });
};

startServer();
