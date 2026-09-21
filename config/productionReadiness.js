const crypto = require('node:crypto');

function isPlaceholder(value) {
  return !value || /^(tu-|un-token|changeme|example|xxx)/i.test(String(value).trim());
}

function validHttpsUrl(value, expectedPath) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (!expectedPath || url.pathname === expectedPath);
  } catch {
    return false;
  }
}

function validateProductionConfig(env = process.env, { strictIntegrations = false } = {}) {
  const blockers = [];
  const warnings = [];
  const integrations = {
    googleOAuth: false,
    webPush: false,
    googleWallet: false,
  };

  if (env.TEST_MODE_ENABLED === 'true') {
    blockers.push('TEST_MODE_ENABLED debe estar desactivado en producción.');
  }

  if (isPlaceholder(env.ADMIN_TOKEN) || String(env.ADMIN_TOKEN || '').length < 32) {
    blockers.push('ADMIN_TOKEN debe ser aleatorio y tener al menos 32 caracteres.');
  }

  if (isPlaceholder(env.GOOGLE_CLIENT_ID) || isPlaceholder(env.GOOGLE_CLIENT_SECRET)) {
    blockers.push('Faltan credenciales reales de Google OAuth.');
  } else if (!validHttpsUrl(env.GOOGLE_REDIRECT_URI, '/auth/google/callback')) {
    blockers.push('GOOGLE_REDIRECT_URI debe usar HTTPS y terminar en /auth/google/callback.');
  } else {
    integrations.googleOAuth = true;
  }

  const pushValues = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT];
  if (pushValues.every(Boolean)) {
    if (!/^mailto:.+@.+\..+$/.test(env.VAPID_SUBJECT) && !validHttpsUrl(env.VAPID_SUBJECT)) {
      warnings.push('VAPID_SUBJECT debe ser un mailto: válido o una URL HTTPS.');
    } else {
      integrations.webPush = true;
    }
  } else {
    warnings.push('Web Push está desactivado: faltan claves VAPID o VAPID_SUBJECT.');
  }

  const walletValues = [
    env.GOOGLE_WALLET_ISSUER_ID,
    env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL,
    env.GOOGLE_WALLET_PRIVATE_KEY,
    env.GOOGLE_WALLET_ORIGIN,
  ];
  if (walletValues.every(Boolean)) {
    try {
      crypto.createPrivateKey(String(env.GOOGLE_WALLET_PRIVATE_KEY).replace(/\\n/g, '\n'));
      if (!/^\d+$/.test(env.GOOGLE_WALLET_ISSUER_ID)) throw new Error('issuer');
      if (!/.+@.+\.iam\.gserviceaccount\.com$/.test(env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL)) throw new Error('email');
      if (!validHttpsUrl(env.GOOGLE_WALLET_ORIGIN)) throw new Error('origin');
      integrations.googleWallet = true;
    } catch {
      warnings.push('La configuración de Google Wallet es inválida (issuer, service account, clave privada u origen HTTPS).');
    }
  } else {
    warnings.push('Google Wallet está desactivado: faltan credenciales del emisor.');
  }

  if (strictIntegrations) blockers.push(...warnings);
  return { ok: blockers.length === 0, blockers, warnings, integrations };
}

module.exports = { validateProductionConfig };
