const crypto = require('node:crypto');

const ISSUER_ID = process.env.GOOGLE_WALLET_ISSUER_ID || '';
const CLASS_SUFFIX = process.env.GOOGLE_WALLET_CLASS_SUFFIX || 'desencajado_loyalty_class';
const SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL || '';
const PRIVATE_KEY = (process.env.GOOGLE_WALLET_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const ORIGIN = process.env.GOOGLE_WALLET_ORIGIN || '';

const configured = Boolean(ISSUER_ID && SERVICE_ACCOUNT_EMAIL && PRIVATE_KEY && ORIGIN);

function isConfigured() {
  return configured;
}

function sanitizeId(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]/g, '_');
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

// Construye el JWT "Save to Google Wallet" (RFC 7519, firmado RS256) con la
// clase y el objeto de fidelidad embebidos: Google los crea/actualiza al
// abrir el link, sin necesidad de llamar antes a la Wallet REST API.
function buildSaveUrl({ user, points }) {
  if (!configured) throw new Error('GOOGLE_WALLET_NOT_CONFIGURED');

  const classId = `${ISSUER_ID}.${sanitizeId(CLASS_SUFFIX)}`;
  const objectId = `${ISSUER_ID}.user_${sanitizeId(user.id)}`;

  const loyaltyClass = {
    id: classId,
    issuerName: 'DESENCAJADO',
    programName: 'DESENCAJADO Rewards',
    reviewStatus: 'UNDER_REVIEW',
    hexBackgroundColor: '#0D1B4B',
  };

  const loyaltyObject = {
    id: objectId,
    classId,
    state: 'ACTIVE',
    accountId: String(user.id),
    accountName: user.name,
    loyaltyPoints: {
      label: 'Estrellas',
      balance: { int: points },
    },
    barcode: {
      type: 'QR_CODE',
      value: user.referralCode,
      alternateText: user.referralCode,
    },
  };

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: SERVICE_ACCOUNT_EMAIL,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    origins: [ORIGIN],
    payload: {
      loyaltyClasses: [loyaltyClass],
      loyaltyObjects: [loyaltyObject],
    },
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), PRIVATE_KEY).toString('base64url');

  return `https://pay.google.com/gp/v/save/${signingInput}.${signature}`;
}

module.exports = { isConfigured, buildSaveUrl };
