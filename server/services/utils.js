function parsePaging(query) {
  const hasLimit = query.limit !== undefined;
  const hasOffset = query.offset !== undefined;

  const limit = hasLimit ? Number.parseInt(query.limit, 10) : null;
  const offset = hasOffset ? Number.parseInt(query.offset, 10) : 0;

  if (hasLimit && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
    return { error: 'limit must be an integer between 1 and 200' };
  }

  if (hasOffset && (!Number.isInteger(offset) || offset < 0)) {
    return { error: 'offset must be an integer greater than or equal to 0' };
  }

  return { limit, offset };
}

function toAmountCents(amount) {
  const amountNum = Number.parseFloat(amount);
  if (!Number.isFinite(amountNum)) {
    return NaN;
  }

  return Math.round(amountNum * 100);
}

function centsToAmount(amountCents) {
  return Number((Number(amountCents) / 100).toFixed(2));
}

function sanitizeTags(tags) {
  const source = Array.isArray(tags)
    ? tags
    : typeof tags === 'string'
      ? tags.split(',')
      : [];

  return [...new Set(
    source
      .map((tag) => String(tag).trim().toLowerCase())
      .filter((tag) => tag.length > 0)
      .map((tag) => tag.slice(0, 24))
  )].slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function parseDateInput(value) {
  if (!value) {
    return null;
  }

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return null;
  }

  return d.toISOString();
}

module.exports = {
  parsePaging,
  toAmountCents,
  centsToAmount,
  sanitizeTags,
  nowIso,
  parseDateInput
};
