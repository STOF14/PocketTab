const isProduction = process.env.NODE_ENV === 'production';

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

function parseSessionTtlDays(value) {
  const parsed = parsePositiveInt(value, 7);
  if (parsed < 1) return 1;
  if (parsed > 30) return 30;
  return parsed;
}

function parseTrustProxy(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return isProduction ? 1 : false;
  }

  if (value === 'true') return true;
  if (value === 'false') return false;

  const parsed = Number.parseInt(value, 10);
  if (Number.isInteger(parsed) && parsed >= 0) {
    return parsed;
  }

  return value;
}

const config = {
  isProduction,
  jsonBodyLimit: process.env.JSON_BODY_LIMIT || (isProduction ? '1mb' : '10mb'),
  slowRequestMs: parsePositiveInt(process.env.SLOW_REQUEST_MS, 1000),
  rateLimit: {
    enabled: !(process.env.NODE_ENV === 'test' || process.env.DISABLE_RATE_LIMIT === 'true'),
    globalMax: parsePositiveInt(process.env.GLOBAL_RATE_LIMIT_MAX, isProduction ? 300 : 100),
    authMax: parsePositiveInt(process.env.AUTH_RATE_LIMIT_MAX, isProduction ? 30 : 10),
    windowMs: parsePositiveInt(process.env.RATE_LIMIT_WINDOW_MS, 60 * 1000)
  },
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  sessionTtlDays: parseSessionTtlDays(process.env.SESSION_TTL_DAYS)
};

module.exports = config;
