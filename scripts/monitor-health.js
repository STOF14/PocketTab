#!/usr/bin/env node

const HEALTH_URL = process.env.HEALTH_URL;
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.HEALTH_TIMEOUT_MS || '5000', 10);

async function run() {
  if (!HEALTH_URL) {
    throw new Error('HEALTH_URL is required');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(HEALTH_URL, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`Health check failed with status ${res.status}`);
    }

    const payload = await res.json();
    if (payload.status !== 'ok') {
      throw new Error(`Health response status is ${payload.status || 'unknown'}`);
    }

    console.log(JSON.stringify({ ok: true, healthUrl: HEALTH_URL, response: payload }));
  } finally {
    clearTimeout(timeout);
  }
}

run().catch((err) => {
  console.error(JSON.stringify({ ok: false, healthUrl: HEALTH_URL || null, error: err.message }));
  process.exit(1);
});
