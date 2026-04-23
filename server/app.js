const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const SqliteRateLimitStore = require('./middleware/sqlite-rate-limit-store');

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
  securityHeaders,
  requestLogger,
  apiNotFoundHandler,
  errorHandler
} = require('./middleware/observability');

const app = express();
app.set('trust proxy', config.trustProxy);

function requireJsonContentType(req, res, next) {
  const methodRequiresJson = req.method === 'POST' || req.method === 'PATCH';
  const isApiRoute = req.path.startsWith('/api/');
  const isAttachmentUpload = req.method === 'POST' && /^\/api\/attachments\/?$/.test(req.path);
  const contentType = req.headers['content-type'];
  const contentLength = Number(req.headers['content-length'] || '0');
  const hasTransferEncoding = typeof req.headers['transfer-encoding'] === 'string';
  const hasRequestBody = contentLength > 0 || hasTransferEncoding;

  if (!methodRequiresJson || !isApiRoute) {
    return next();
  }

  if (!contentType && !hasRequestBody) {
    return next();
  }

  if (isAttachmentUpload && req.is('multipart/form-data')) {
    return next();
  }

  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Unsupported Media Type. Use application/json' });
  }

  return next();
}

// Middleware
app.use(requireJsonContentType);
app.use(express.json({ limit: config.jsonBodyLimit }));
app.use(securityHeaders);
app.use(requestLogger({ slowRequestMs: config.slowRequestMs }));

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

if (config.rateLimit.enabled) {
  const globalLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.globalMax,
    standardHeaders: true,
    legacyHeaders: false,
    store: new SqliteRateLimitStore({ prefix: 'global' }),
    message: { error: 'Too many requests, please try again later' }
  });
  app.use('/api', globalLimiter);

  const authLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.authMax,
    standardHeaders: true,
    legacyHeaders: false,
    store: new SqliteRateLimitStore({ prefix: 'auth' }),
    message: { error: 'Too many login attempts, please try again later' }
  });
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);

  const householdAccessLimiter = rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.householdAccessMax,
    standardHeaders: true,
    legacyHeaders: false,
    store: new SqliteRateLimitStore({ prefix: 'household-access' }),
    message: { error: 'Too many household access attempts, please try again later' }
  });
  app.use('/api/auth/household/access', householdAccessLimiter);
  app.use('/api/auth/household/recover-reset', householdAccessLimiter);
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
