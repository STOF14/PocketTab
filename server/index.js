const app = require('./app');
const PORT = process.env.PORT || 3000;
const SHUTDOWN_TIMEOUT_MS = 10000;

const server = app.listen(PORT, () => {
  console.log(`PocketTab server running on http://localhost:${PORT}`);
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down gracefully...`);

  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
