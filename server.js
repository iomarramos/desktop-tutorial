const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  addSubscriber, dniExists, getCount, listSubscribers,
  upsertGoogleUser, getUserById, getUserByEmail, getUserByReferralCode, setReferredBy,
  setTotpSecret, enableTotp,
  createSession, getSession, setSessionStage, deleteSession,
  addPurchase, getPointsBalance, listPurchasesByUser, redeemPoints, SOLES_PER_PUNTO,
  createFamilyGroup, joinFamilyGroup, getFamilyGroupForUser,
  adminListUsers, adminListReferrals, adminListFamilyGroups, adminListPurchases, adminTrafficStats,
} = require('./db');
const google = require('./auth/google');
const totp = require('./auth/totp');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
const SESSION_COOKIE = 'sid';
const STATE_COOKIE = 'oauth_state';
const REF_COOKIE = 'pending_ref';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

function readBody(req, maxBytes = 10_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  return raw ? JSON.parse(raw) : {};
}

function normalizePhone(raw) {
  return String(raw || '').replace(/[\s-]/g, '');
}

function validateSubscription({ nombre, telefono, dni, unasam }) {
  const errors = {};

  const cleanNombre = String(nombre || '').trim();
  if (cleanNombre.length < 2 || cleanNombre.length > 100) {
    errors.nombre = 'El nombre debe tener entre 2 y 100 caracteres.';
  }

  const cleanTelefono = normalizePhone(telefono);
  if (!/^9\d{8}$/.test(cleanTelefono)) {
    errors.telefono = 'Ingresa un celular peruano válido (9 dígitos, empieza con 9).';
  }

  const cleanDni = String(dni || '').trim();
  if (!/^\d{8}$/.test(cleanDni)) {
    errors.dni = 'El DNI debe tener exactamente 8 dígitos.';
  }

  const cleanUnasam = unasam === 'Sí' || unasam === 'No' ? unasam : null;
  if (!cleanUnasam) {
    errors.unasam = 'Indica si eres estudiante UNASAM.';
  }

  return {
    errors,
    value: { nombre: cleanNombre, telefono: cleanTelefono, dni: cleanDni, unasam: cleanUnasam },
  };
}

function isAuthorizedAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const provided = req.headers['x-admin-token'] || '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ───────────────────────── cookies ─────────────────────────

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

function isHttpsRequest(req) {
  return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);
}

function cookieString(req, name, value, { maxAge } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (isHttpsRequest(req)) parts.push('Secure');
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

function clearCookieString(req, name) {
  return cookieString(req, name, '', { maxAge: 0 });
}

function getSessionFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  const session = getSession(token);
  return session ? { token, session } : null;
}

function requireActiveUser(req) {
  const found = getSessionFromRequest(req);
  if (!found || found.session.stage !== 'active') return null;
  return getUserById(found.session.user_id);
}

// ───────────────────────── perfil / wallet ─────────────────────────

function serializeUser(user) {
  const balance = getPointsBalance(user.id);
  const family = getFamilyGroupForUser(user.id);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatar_url,
    puntos: balance,
    referralCode: user.referral_code,
    totpEnabled: Boolean(user.totp_enabled),
    familyGroup: family,
    solesPerPunto: SOLES_PER_PUNTO,
  };
}

async function handleMe(req, res) {
  const found = getSessionFromRequest(req);
  if (!found) return sendJson(res, 200, { authenticated: false });

  const user = getUserById(found.session.user_id);
  if (!user) return sendJson(res, 200, { authenticated: false });

  if (found.session.stage !== 'active') {
    return sendJson(res, 200, {
      authenticated: false,
      stage: found.session.stage,
      name: user.name,
      email: user.email,
    });
  }

  sendJson(res, 200, { authenticated: true, stage: 'active', user: serializeUser(user) });
}

// ───────────────────────── auth Google + 2FA ─────────────────────────

function handleGoogleStart(req, res, query) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Login con Google no está configurado (faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  }
  const state = crypto.randomBytes(16).toString('base64url');
  const headers = { Location: google.buildAuthUrl({ clientId: GOOGLE_CLIENT_ID, redirectUri: GOOGLE_REDIRECT_URI, state }) };
  const cookies = [cookieString(req, STATE_COOKIE, state, { maxAge: 600 })];
  const ref = String(query.get('ref') || '').trim();
  if (ref) cookies.push(cookieString(req, REF_COOKIE, ref, { maxAge: 600 }));
  headers['Set-Cookie'] = cookies;
  res.writeHead(302, headers);
  res.end();
}

async function handleGoogleCallback(req, res, query) {
  const cookies = parseCookies(req);
  const code = query.get('code');
  const state = query.get('state');

  if (!code || !state || state !== cookies[STATE_COOKIE]) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Solicitud de login inválida o expirada.');
  }

  try {
    const tokens = await google.exchangeCode({
      code,
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUri: GOOGLE_REDIRECT_URI,
    });
    const payload = await google.verifyIdToken(tokens.id_token, GOOGLE_CLIENT_ID);

    const user = upsertGoogleUser({
      googleId: payload.sub,
      email: payload.email,
      name: payload.name || payload.email,
      avatarUrl: payload.picture,
    });

    const refCode = cookies[REF_COOKIE];
    if (refCode) {
      const referrer = getUserByReferralCode(refCode);
      if (referrer) setReferredBy(user.id, referrer.id);
    }

    const stage = user.totp_enabled ? 'pending_2fa' : 'needs_2fa_setup';
    const token = createSession(user.id, stage);

    res.writeHead(302, {
      Location: '/cuenta.html',
      'Set-Cookie': [
        cookieString(req, SESSION_COOKIE, token, { maxAge: 30 * 86400 }),
        clearCookieString(req, STATE_COOKIE),
        clearCookieString(req, REF_COOKIE),
      ],
    });
    res.end();
  } catch {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('No pudimos verificar tu cuenta de Google. Intenta de nuevo.');
  }
}

function handleLogout(req, res) {
  const found = getSessionFromRequest(req);
  if (found) deleteSession(found.token);
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Set-Cookie': clearCookieString(req, SESSION_COOKIE) });
  res.end(JSON.stringify({ ok: true }));
}

async function handleTotpSetup(req, res) {
  const found = getSessionFromRequest(req);
  if (!found || found.session.stage !== 'needs_2fa_setup') {
    return sendJson(res, 400, { ok: false, error: 'No corresponde configurar 2FA en este momento.' });
  }
  const user = getUserById(found.session.user_id);
  const secret = totp.generateSecret();
  setTotpSecret(user.id, secret);
  sendJson(res, 200, { ok: true, secret, otpauthUrl: totp.otpauthUrl({ secret, email: user.email }) });
}

async function handleTotpVerify(req, res) {
  const found = getSessionFromRequest(req);
  if (!found || (found.session.stage !== 'needs_2fa_setup' && found.session.stage !== 'pending_2fa')) {
    return sendJson(res, 400, { ok: false, error: 'No hay una verificación 2FA pendiente.' });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  const user = getUserById(found.session.user_id);
  if (!user.totp_secret) {
    return sendJson(res, 400, { ok: false, error: 'Primero solicita el código QR de configuración.' });
  }

  if (!totp.verifyTOTP(user.totp_secret, body.code)) {
    return sendJson(res, 401, { ok: false, error: 'Código incorrecto. Verifica la hora de tu dispositivo e intenta de nuevo.' });
  }

  if (found.session.stage === 'needs_2fa_setup') enableTotp(user.id);
  setSessionStage(found.token, 'active');
  sendJson(res, 200, { ok: true, user: serializeUser(getUserById(user.id)) });
}

// ───────────────────────── wallet (compras / canje / familia) ─────────────────────────

function handlePurchasesList(req, res, query) {
  const user = requireActiveUser(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });
  const result = listPurchasesByUser(user.id, { page: query.get('page'), limit: query.get('limit') });
  sendJson(res, 200, { ok: true, ...result });
}

async function handlePointsRedeem(req, res) {
  const user = requireActiveUser(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  try {
    const balance = redeemPoints(user.id, body.puntos, body.motivo);
    sendJson(res, 200, { ok: true, balance });
  } catch (err) {
    const msg = err.message === 'INSUFFICIENT_BALANCE'
      ? 'No tienes suficientes puntos para este canje.'
      : 'Cantidad de puntos inválida.';
    sendJson(res, 400, { ok: false, error: msg });
  }
}

async function handleFamilyCreate(req, res) {
  const user = requireActiveUser(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  const name = String(body.name || '').trim();
  if (name.length < 2 || name.length > 60) {
    return sendJson(res, 400, { ok: false, error: 'Ingresa un nombre de grupo válido.' });
  }
  const group = createFamilyGroup(user.id, name);
  sendJson(res, 201, { ok: true, group });
}

async function handleFamilyJoin(req, res) {
  const user = requireActiveUser(req);
  if (!user) return sendJson(res, 401, { ok: false, error: 'No autenticado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  try {
    const group = joinFamilyGroup(user.id, body.inviteCode);
    sendJson(res, 200, { ok: true, group });
  } catch {
    sendJson(res, 404, { ok: false, error: 'Código de invitación no encontrado.' });
  }
}

// ───────────────────────── suscripción pre-apertura (existente) ─────────────────────────

async function handleSubscribe(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    return sendJson(res, 413, { ok: false, error: 'Solicitud demasiado grande.' });
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  const { errors, value } = validateSubscription(data);
  if (Object.keys(errors).length > 0) {
    return sendJson(res, 400, { ok: false, errors });
  }

  if (dniExists(value.dni)) {
    return sendJson(res, 409, {
      ok: false,
      error: 'Ese DNI ya está registrado. ¡Ya estás en la lista!',
    });
  }

  addSubscriber(value);
  return sendJson(res, 201, { ok: true, total: getCount() });
}

function handleCount(req, res) {
  sendJson(res, 200, { ok: true, total: getCount() });
}

function handleAdminList(req, res) {
  if (!isAuthorizedAdmin(req)) {
    return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  }
  sendJson(res, 200, { ok: true, subscribers: listSubscribers() });
}

// ───────────────────────── administrador (wallet / tráfico / referidos / familia) ─────────────────────────

function paginationParams(query) {
  return { page: query.get('page'), limit: query.get('limit') };
}

async function handleAdminPurchaseCreate(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });

  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON inválido.' });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const monto = Number(body.monto);
  if (!email || !(monto > 0)) {
    return sendJson(res, 400, { ok: false, error: 'Se requiere email del cliente y un monto válido.' });
  }

  const target = getUserByEmail(email);
  if (!target) {
    return sendJson(res, 404, { ok: false, error: 'Ese cliente aún no inició sesión con Google (no tiene wallet).' });
  }

  const result = addPurchase({ userId: target.id, monto, producto: body.producto });
  sendJson(res, 201, { ok: true, ...result });
}

function handleAdminUsers(req, res, query) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, { ok: true, ...adminListUsers(paginationParams(query)) });
}

function handleAdminReferrals(req, res, query) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, { ok: true, ...adminListReferrals(paginationParams(query)) });
}

function handleAdminFamilyGroups(req, res, query) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, { ok: true, ...adminListFamilyGroups(paginationParams(query)) });
}

function handleAdminPurchases(req, res, query) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, { ok: true, ...adminListPurchases(paginationParams(query)) });
}

function handleAdminTraffic(req, res) {
  if (!isAuthorizedAdmin(req)) return sendJson(res, 401, { ok: false, error: 'No autorizado.' });
  sendJson(res, 200, { ok: true, ...adminTrafficStats() });
}

// ───────────────────────── estáticos ─────────────────────────

function serveStatic(req, res, urlPath) {
  const requestPath = decodeURIComponent(urlPath);
  const relativePath = requestPath === '/' ? '/index.html' : requestPath;
  const resolvedPath = path.normalize(path.join(PUBLIC_DIR, relativePath));

  if (!resolvedPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(resolvedPath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 - No encontrado');
    }
    const ext = path.extname(resolvedPath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

// ───────────────────────── router ─────────────────────────

const server = http.createServer(async (req, res) => {
  const fullUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const url = fullUrl.pathname;
  const query = fullUrl.searchParams;

  try {
    // suscripción pre-apertura
    if (req.method === 'POST' && url === '/api/subscribe') return handleSubscribe(req, res);
    if (req.method === 'GET' && url === '/api/subscribe/count') return handleCount(req, res);
    if (req.method === 'GET' && url === '/api/admin/subscribers') return handleAdminList(req, res);

    // auth Google + 2FA
    if (req.method === 'GET' && url === '/auth/google') return handleGoogleStart(req, res, query);
    if (req.method === 'GET' && url === '/auth/google/callback') return handleGoogleCallback(req, res, query);
    if (req.method === 'POST' && url === '/api/logout') return handleLogout(req, res);
    if (req.method === 'GET' && url === '/api/me') return handleMe(req, res);
    if (req.method === 'POST' && url === '/api/2fa/setup') return handleTotpSetup(req, res);
    if (req.method === 'POST' && url === '/api/2fa/verify') return handleTotpVerify(req, res);

    // wallet del usuario
    if (req.method === 'GET' && url === '/api/purchases') return handlePurchasesList(req, res, query);
    if (req.method === 'POST' && url === '/api/points/redeem') return handlePointsRedeem(req, res);
    if (req.method === 'POST' && url === '/api/family/create') return handleFamilyCreate(req, res);
    if (req.method === 'POST' && url === '/api/family/join') return handleFamilyJoin(req, res);

    // admin
    if (req.method === 'POST' && url === '/api/admin/purchases') return handleAdminPurchaseCreate(req, res);
    if (req.method === 'GET' && url === '/api/admin/purchases') return handleAdminPurchases(req, res, query);
    if (req.method === 'GET' && url === '/api/admin/users') return handleAdminUsers(req, res, query);
    if (req.method === 'GET' && url === '/api/admin/referrals') return handleAdminReferrals(req, res, query);
    if (req.method === 'GET' && url === '/api/admin/family-groups') return handleAdminFamilyGroups(req, res, query);
    if (req.method === 'GET' && url === '/api/admin/stats/traffic') return handleAdminTraffic(req, res);

    if (req.method === 'GET') return serveStatic(req, res, url);

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Método no permitido');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Error interno del servidor.' });
  }
});

server.listen(PORT, () => {
  console.log(`DESENCAJADO suscripción escuchando en http://localhost:${PORT}`);
});
