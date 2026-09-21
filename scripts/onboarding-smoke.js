#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateTOTP } = require('../auth/totp');

const port = 4300 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;
const testToken = `onboarding-${Date.now()}-isolated`;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desencajado-onboarding-'));
const child = spawn(process.execPath, ['server.js'], {
  cwd: path.join(__dirname, '..'),
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    DB_FILE: path.join(tempDir, 'test.sqlite'),
    ADMIN_TOKEN: 'test-admin-token-not-for-production',
    TEST_MODE_ENABLED: 'true',
    TEST_MODE_TOKEN: testToken,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 125));
  }
  throw new Error(`El servidor no inició. ${stderr}`);
}

async function request(pathname, { method = 'GET', cookie, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: 'manual',
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}

function assertStage(actual, expected) {
  if (actual !== expected) throw new Error(`Etapa esperada ${expected}; recibida ${actual || '(vacía)'}.`);
  console.log(`✓ ${expected}`);
}

async function run() {
  await waitForServer();

  const created = await request('/api/test/session', {
    method: 'POST',
    headers: { 'x-test-token': testToken },
  });
  if (created.response.status !== 201) throw new Error('No se pudo crear la cuenta aislada.');
  const cookie = created.response.headers.get('set-cookie').split(';')[0];

  let me = await request('/api/me', { cookie });
  assertStage(me.data.stage, 'needs_profile');

  const dni = String(10_000_000 + Math.floor(Math.random() * 80_000_000));
  const profile = await request('/api/profile/complete', {
    method: 'POST', cookie, body: { dni, telefono: '999999999' },
  });
  if (!profile.response.ok) throw new Error(profile.data.error || 'Falló el perfil.');

  me = await request('/api/me', { cookie });
  assertStage(me.data.stage, 'needs_2fa_setup');

  const setup = await request('/api/2fa/setup', { method: 'POST', cookie });
  if (!setup.response.ok || !setup.data.secret) throw new Error('No se generó el 2FA.');
  const verified = await request('/api/2fa/verify', {
    method: 'POST', cookie, body: { code: generateTOTP(setup.data.secret) },
  });
  if (!verified.response.ok) throw new Error(verified.data.error || 'Falló el 2FA.');

  me = await request('/api/me', { cookie });
  assertStage(me.data.stage, 'active');
  if (me.data.user.puntos !== 0) throw new Error('La cuenta nueva no inició con saldo cero.');
  console.log('✓ cuenta aislada activa con saldo inicial correcto');

  const wallet = await request('/api/wallet/google-pass', { cookie });
  if (wallet.response.status !== 501) throw new Error('Google Wallet debería indicar que falta configuración.');
  const push = await request('/api/push/vapid-public-key', { cookie });
  if (push.data.configured !== false) throw new Error('Push debería estar desactivado sin claves VAPID.');
  console.log('✓ degradación segura de Push y Google Wallet sin credenciales');
}

run()
  .then(() => { console.log('Onboarding aislado: OK'); })
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => {
    child.kill('SIGTERM');
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

