const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const MIN_PIN_BCRYPT_ROUNDS = 12;
const isProduction = process.env.NODE_ENV === 'production';

function resolveRounds(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    return MIN_PIN_BCRYPT_ROUNDS;
  }

  return Math.max(MIN_PIN_BCRYPT_ROUNDS, parsed);
}

function resolvePinPepper() {
  if (typeof process.env.PIN_PEPPER === 'string' && process.env.PIN_PEPPER.length > 0) {
    return process.env.PIN_PEPPER;
  }

  if (isProduction) {
    throw new Error('PIN_PEPPER is required when NODE_ENV=production');
  }

  const ephemeralPepper = crypto.randomBytes(32).toString('hex');
  process.env.PIN_PEPPER = ephemeralPepper;
  console.warn('PIN_PEPPER not set. Generated an ephemeral dev pepper; PIN hashes from this run will not verify after restart.');
  return ephemeralPepper;
}

const PIN_BCRYPT_ROUNDS = resolveRounds(process.env.PIN_BCRYPT_ROUNDS || String(MIN_PIN_BCRYPT_ROUNDS));
const PIN_PEPPER = resolvePinPepper();

function applyPepper(pin) {
  return `${String(pin)}${PIN_PEPPER}`;
}

function hashPin(pin) {
  return bcrypt.hashSync(applyPepper(pin), PIN_BCRYPT_ROUNDS);
}

function safeCompare(candidate, hash) {
  try {
    return bcrypt.compareSync(candidate, hash);
  } catch (err) {
    return false;
  }
}

function verifyPin(pin, hash) {
  const pepperedMatch = safeCompare(applyPepper(pin), hash);
  if (pepperedMatch) {
    return { matched: true, matchedWithPepper: true };
  }

  const legacyMatch = safeCompare(String(pin), hash);
  if (legacyMatch) {
    return { matched: true, matchedWithPepper: false };
  }

  return { matched: false, matchedWithPepper: false };
}

function getHashRounds(hash) {
  try {
    return bcrypt.getRounds(hash);
  } catch (err) {
    return 0;
  }
}

function needsPinRehash(hash, matchedWithPepper, explicitRehashFlag) {
  if (explicitRehashFlag) {
    return true;
  }

  if (!matchedWithPepper) {
    return true;
  }

  return getHashRounds(hash) < PIN_BCRYPT_ROUNDS;
}

module.exports = {
  hashPin,
  verifyPin,
  needsPinRehash,
  PIN_BCRYPT_ROUNDS,
  PIN_PEPPER
};
