const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validateProductionConfig } = require('../config/productionReadiness');

function validEnv() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    ADMIN_TOKEN: 'a'.repeat(32),
    GOOGLE_CLIENT_ID: 'client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'real-secret',
    GOOGLE_REDIRECT_URI: 'https://desencajado.pe/auth/google/callback',
    VAPID_PUBLIC_KEY: 'public',
    VAPID_PRIVATE_KEY: 'private',
    VAPID_SUBJECT: 'mailto:admin@desencajado.pe',
    GOOGLE_WALLET_ISSUER_ID: '123456789',
    GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL: 'wallet@project.iam.gserviceaccount.com',
    GOOGLE_WALLET_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    GOOGLE_WALLET_ORIGIN: 'https://desencajado.pe',
  };
}

test('preflight acepta una configuración completa de producción', () => {
  const result = validateProductionConfig(validEnv(), { strictIntegrations: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.integrations, { googleOAuth: true, webPush: true, googleWallet: true });
});

test('preflight bloquea modo de prueba, token débil y OAuth sin HTTPS', () => {
  const env = validEnv();
  env.TEST_MODE_ENABLED = 'true';
  env.ADMIN_TOKEN = 'corto';
  env.GOOGLE_REDIRECT_URI = 'http://desencajado.pe/auth/google/callback';
  const result = validateProductionConfig(env);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.some((item) => item.includes('TEST_MODE_ENABLED')));
  assert.ok(result.blockers.some((item) => item.includes('ADMIN_TOKEN')));
  assert.ok(result.blockers.some((item) => item.includes('GOOGLE_REDIRECT_URI')));
});

test('integraciones opcionales son advertencias salvo en modo estricto', () => {
  const env = validEnv();
  delete env.VAPID_PUBLIC_KEY;
  delete env.GOOGLE_WALLET_PRIVATE_KEY;
  assert.equal(validateProductionConfig(env).ok, true);
  assert.equal(validateProductionConfig(env, { strictIntegrations: true }).ok, false);
});
