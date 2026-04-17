const db = require('../db');

class SqliteRateLimitStore {
  constructor(options = {}) {
    this.prefix = options.prefix || 'rate_limit';
    this.localKeys = true;
    this.windowMs = 60 * 1000;
    this.cleanupInterval = null;
  }

  scopedKey(key) {
    return `${this.prefix}:${key}`;
  }

  init(options) {
    this.windowMs = Number.isInteger(options?.windowMs) && options.windowMs > 0
      ? options.windowMs
      : this.windowMs;

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(() => {
      try {
        const cutoff = Date.now() - this.windowMs;
        db.prepare('DELETE FROM rate_limit_attempts WHERE key LIKE ? AND window_start <= ?').run(`${this.prefix}:%`, cutoff);
      } catch (err) {
        // Ignore cleanup errors during shutdown.
      }
    }, this.windowMs);
    this.cleanupInterval.unref?.();
  }

  async get(key) {
    const row = db.prepare('SELECT count, window_start FROM rate_limit_attempts WHERE key = ?').get(this.scopedKey(key));
    if (!row) {
      return undefined;
    }

    return {
      totalHits: row.count,
      resetTime: new Date(row.window_start + this.windowMs)
    };
  }

  async increment(key) {
    const scopedKey = this.scopedKey(key);
    const now = Date.now();
    const existing = db.prepare('SELECT count, window_start FROM rate_limit_attempts WHERE key = ?').get(scopedKey);

    let totalHits = 1;
    let windowStart = now;

    if (existing) {
      const expired = now - existing.window_start >= this.windowMs;
      if (expired) {
        db.prepare('UPDATE rate_limit_attempts SET count = 1, window_start = ? WHERE key = ?').run(now, scopedKey);
      } else {
        totalHits = existing.count + 1;
        windowStart = existing.window_start;
        db.prepare('UPDATE rate_limit_attempts SET count = ? WHERE key = ?').run(totalHits, scopedKey);
      }
    } else {
      db.prepare('INSERT INTO rate_limit_attempts (key, count, window_start) VALUES (?, 1, ?)').run(scopedKey, now);
    }

    return {
      totalHits,
      resetTime: new Date(windowStart + this.windowMs)
    };
  }

  async decrement(key) {
    const scopedKey = this.scopedKey(key);
    const existing = db.prepare('SELECT count FROM rate_limit_attempts WHERE key = ?').get(scopedKey);
    if (!existing) {
      return;
    }

    const nextCount = Math.max(0, existing.count - 1);
    db.prepare('UPDATE rate_limit_attempts SET count = ? WHERE key = ?').run(nextCount, scopedKey);
  }

  async resetKey(key) {
    db.prepare('DELETE FROM rate_limit_attempts WHERE key = ?').run(this.scopedKey(key));
  }

  async resetAll() {
    db.prepare('DELETE FROM rate_limit_attempts WHERE key LIKE ?').run(`${this.prefix}:%`);
  }

  shutdown() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

module.exports = SqliteRateLimitStore;
