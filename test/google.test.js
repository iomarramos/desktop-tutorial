const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAuthUrl, verifyIdToken } = require('../auth/google');

test('OAuth URL conserva state, redirect URI y scopes mínimos', () => {
  const url = new URL(buildAuthUrl({
    clientId: 'client-id',
    redirectUri: 'https://desencajado.pe/auth/google/callback',
    state: 'random-state',
  }));
  assert.equal(url.searchParams.get('state'), 'random-state');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://desencajado.pe/auth/google/callback');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
});

test('verificación rechaza correo no verificado y token vencido', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      aud: 'client-id', iss: 'https://accounts.google.com', sub: '1', email: 'test@example.com',
      email_verified: 'false', exp: String(Math.floor(Date.now() / 1000) + 60),
    }),
  });
  await assert.rejects(() => verifyIdToken('token', 'client-id'), /GOOGLE_EMAIL_NOT_VERIFIED/);

  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      aud: 'client-id', iss: 'https://accounts.google.com', sub: '1', email: 'test@example.com',
      email_verified: 'true', exp: '1',
    }),
  });
  await assert.rejects(() => verifyIdToken('token', 'client-id'), /GOOGLE_TOKEN_EXPIRED/);
});
