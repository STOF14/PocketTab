const crypto = require('crypto');

const FRUIT_WORDS = [
  'APPLE',
  'APRICOT',
  'AVOCADO',
  'BANANA',
  'BLACKBERRY',
  'BLUEBERRY',
  'CHERRY',
  'COCONUT',
  'CRANBERRY',
  'DATE',
  'FIG',
  'GOOSEBERRY',
  'GRAPE',
  'GRAPEFRUIT',
  'GUAVA',
  'KIWI',
  'LEMON',
  'LIME',
  'LYCHEE',
  'MANGO',
  'MELON',
  'NECTARINE',
  'ORANGE',
  'PAPAYA',
  'PASSIONFRUIT',
  'PEACH',
  'PEAR',
  'PINEAPPLE',
  'PLUM',
  'POMEGRANATE',
  'RASPBERRY',
  'STRAWBERRY',
  'TANGERINE',
  'WATERMELON'
];

function normalizeHouseholdLoginId(value) {
  return String(value || '').trim().toUpperCase();
}

function isValidHouseholdCode(code) {
  return /^\d{6}$/.test(String(code || '').trim());
}

function generateHouseholdCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function randomFruit() {
  return FRUIT_WORDS[crypto.randomInt(0, FRUIT_WORDS.length)];
}

function buildHouseholdLoginIdCandidate(attempt) {
  const fruit = randomFruit();
  if (attempt < FRUIT_WORDS.length * 3) {
    return `PT-${fruit}`;
  }

  // Temporary fallback if pure fruit IDs are exhausted by collisions.
  return `PT-${fruit}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

function generateUniqueHouseholdLoginId(isTakenFn, maxAttempts = 500) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = buildHouseholdLoginIdCandidate(attempt);
    if (!isTakenFn(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to allocate unique household login ID');
}

module.exports = {
  FRUIT_WORDS,
  normalizeHouseholdLoginId,
  isValidHouseholdCode,
  generateHouseholdCode,
  generateUniqueHouseholdLoginId
};
