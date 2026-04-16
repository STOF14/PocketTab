const crypto = require('crypto');

const DEFAULT_SLOW_REQUEST_MS = 1000;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function writeLog(level, payload) {
  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
    return;
  }

  if (level === 'warn') {
    console.warn(line);
    return;
  }

  console.log(line);
}

function requestLogger(options = {}) {
  const slowRequestMs = parsePositiveInt(options.slowRequestMs, DEFAULT_SLOW_REQUEST_MS);

  return function logRequest(req, res, next) {
    const requestId = req.get('x-request-id') || crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const durationMs = Number(elapsedMs.toFixed(2));

      const statusCode = res.statusCode;
      const level = statusCode >= 500
        ? 'error'
        : statusCode >= 400 || durationMs >= slowRequestMs
          ? 'warn'
          : 'info';

      writeLog(level, {
        timestamp: new Date().toISOString(),
        level,
        type: 'http_request',
        requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode,
        durationMs,
        userId: req.userId || null,
        ip: getClientIp(req),
        userAgent: req.get('user-agent') || null
      });
    });

    next();
  };
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  next();
}

function apiNotFoundHandler(req, res) {
  res.status(404).json({
    error: 'API endpoint not found',
    requestId: req.requestId || null
  });
}

function errorHandler(err, req, res, next) {
  const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
  const isServerError = statusCode >= 500;
  const requestId = req.requestId || null;

  writeLog('error', {
    timestamp: new Date().toISOString(),
    level: 'error',
    type: 'http_error',
    requestId,
    method: req.method,
    path: req.originalUrl,
    statusCode,
    message: err?.message || 'Unhandled error',
    stack: process.env.NODE_ENV === 'production' ? undefined : err?.stack
  });

  if (res.headersSent) {
    return next(err);
  }

  return res.status(statusCode).json({
    error: isServerError ? 'Internal server error' : (err?.message || 'Request failed'),
    requestId
  });
}

module.exports = {
  securityHeaders,
  requestLogger,
  apiNotFoundHandler,
  errorHandler
};
