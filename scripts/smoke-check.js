#!/usr/bin/env node

const BASE_URL = (process.env.SMOKE_BASE_URL || '').replace(/\/+$/, '');
const PIN = process.env.SMOKE_TEST_PIN || '1234';
const TIMEOUT_MS = Number.parseInt(process.env.SMOKE_TIMEOUT_MS || '10000', 10);
const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

if (!BASE_URL) {
  console.error(JSON.stringify({ ok: false, error: 'SMOKE_BASE_URL is required' }));
  process.exit(1);
}

function timeoutSignal() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

async function api(method, path, body, token) {
  const timeout = timeoutSignal();
  try {
    const headers = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${BASE_URL}/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: timeout.signal
    });

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    return { status: res.status, data };
  } finally {
    timeout.clear();
  }
}

async function run() {
  const registerA = await api('POST', '/auth/register', { name: `SmokeA-${suffix}`, pin: PIN });
  if (registerA.status !== 201 || !registerA.data?.token) {
    throw new Error('Register A failed');
  }

  const registerB = await api('POST', '/auth/register', { name: `SmokeB-${suffix}`, pin: PIN });
  if (registerB.status !== 201 || !registerB.data?.user?.id) {
    throw new Error('Register B failed');
  }

  const tokenA = registerA.data.token;
  const userB = registerB.data.user;

  const requestRes = await api('POST', '/requests', { toId: userB.id, amount: 10, reason: 'smoke' }, tokenA);
  if (requestRes.status !== 201) {
    throw new Error('Request creation failed');
  }

  const healthRes = await api('GET', '/health');
  if (healthRes.status !== 200 || healthRes.data?.status !== 'ok') {
    throw new Error('Health endpoint failed');
  }

  console.log(
    JSON.stringify({
      ok: true,
      baseUrl: BASE_URL,
      requestId: requestRes.data.id,
      healthStatus: healthRes.data.status
    })
  );
}

run().catch((err) => {
  console.error(JSON.stringify({ ok: false, baseUrl: BASE_URL, error: err.message }));
  process.exit(1);
});
