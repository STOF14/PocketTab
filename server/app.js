const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');

// Initialize database (creates tables on first run)
const db = require('./db');

const authRoutes = require('./routes/auth');
const requestRoutes = require('./routes/requests');
const paymentRoutes = require('./routes/payments');
const messageRoutes = require('./routes/messages');
const userRoutes = require('./routes/users');
const notificationRoutes = require('./routes/notifications');
const recurringRoutes = require('./routes/recurring');
const allowanceRoutes = require('./routes/allowances');
const settlementRoutes = require('./routes/settlements');
const reportRoutes = require('./routes/reports');
const attachmentRoutes = require('./routes/attachments');
const {
  requestLogger,
  apiNotFoundHandler,
  errorHandler
} = require('./middleware/observability');

const app = express();
const slowRequestMs = Number.parseInt(process.env.SLOW_REQUEST_MS || '1000', 10);

// Middleware
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '10mb' }));
app.use(requestLogger({ slowRequestMs }));

// Health check endpoint for monitors and uptime checks
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1 as ok').get();
    return res.json({
      status: 'ok',
      service: 'pockettab-api',
      time: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime())
    });
  } catch (err) {
    return res.status(503).json({
      status: 'degraded',
      service: 'pockettab-api',
      error: 'Database unavailable',
      requestId: req.requestId || null
    });
  }
});

// Global rate limiter: 100 requests per minute per IP
const disableRateLimit = process.env.NODE_ENV === 'test' || process.env.DISABLE_RATE_LIMIT === 'true';
if (!disableRateLimit) {
  const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later' }
  });
  app.use('/api', globalLimiter);

  // Stricter rate limiter for auth endpoints (login/register): 10 per minute
  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, please try again later' }
  });
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);
}

// Serve static files from public/
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/users', userRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/recurring', recurringRoutes);
app.use('/api/allowances', allowanceRoutes);
app.use('/api/settlements', settlementRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api', apiNotFoundHandler);

// Fallback: serve index.html for any non-API route
app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Centralized error handler
app.use(errorHandler);

module.exports = app;