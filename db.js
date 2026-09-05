const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
// DB_FILE permite apuntar a otra base (ej. una temporal en los tests) sin
// tocar la de desarrollo; por defecto sigue siendo data/suscripciones.sqlite.
const DB_PATH = process.env.DB_FILE || path.join(DATA_DIR, 'suscripciones.sqlite');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    telefono TEXT NOT NULL,
    dni TEXT NOT NULL UNIQUE,
    unasam TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_id TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    avatar_url TEXT,
    referral_code TEXT NOT NULL UNIQUE,
    referred_by INTEGER,
    family_group_id INTEGER,
    totp_secret TEXT,
    totp_enabled INTEGER NOT NULL DEFAULT 0,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS family_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_user_id INTEGER NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    monto REAL NOT NULL,
    producto TEXT,
    puntos INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS points_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    stage TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    pushed_to INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    photo_url TEXT,
    price REAL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS promotion_products (
    promotion_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    PRIMARY KEY (promotion_id, product_id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS promotion_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    promotion_id INTEGER NOT NULL,
    code TEXT NOT NULL UNIQUE,
    label TEXT,
    max_uses INTEGER,
    uses_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS promotion_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    promotion_code_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migración in-place: agrega columnas nuevas a `promotions` si la base de
// datos ya existía de una versión anterior (SQLite no soporta
// "ADD COLUMN IF NOT EXISTS").
function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('promotions', 'photo_url', 'TEXT');
ensureColumn('promotions', 'starts_at', 'TEXT');
ensureColumn('promotions', 'ends_at', 'TEXT');
ensureColumn('promotions', 'publication_code', 'TEXT');
ensureColumn('sessions', 'totp_attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('sessions', 'totp_locked_until', 'TEXT');
ensureColumn('users', 'wallet_saved_at', 'TEXT');
ensureColumn('users', 'last_spin_at', 'TEXT');
ensureColumn('users', 'dni', 'TEXT');
ensureColumn('users', 'telefono', 'TEXT');

// Único entre quienes ya lo llenaron: SQLite no deja agregar UNIQUE en un
// ALTER TABLE ADD COLUMN, así que va como índice parcial aparte. Permite
// múltiples NULL (usuarios que aún no completaron su perfil).
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_dni ON users(dni) WHERE dni IS NOT NULL');

db.exec('CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_user ON points_ledger(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_promo_products_promo ON promotion_products(promotion_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_promo_codes_promo ON promotion_codes(promotion_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_promo_redemptions_code ON promotion_redemptions(promotion_code_id)');

const SOLES_PER_PUNTO = Number(process.env.SOLES_PER_PUNTO) > 0 ? Number(process.env.SOLES_PER_PUNTO) : 5;
const REWARD_THRESHOLD = Number(process.env.REWARD_THRESHOLD) > 0 ? Number(process.env.REWARD_THRESHOLD) : 50;
const REFERRAL_BONUS_POINTS = Number(process.env.REFERRAL_BONUS_POINTS) >= 0 ? Number(process.env.REFERRAL_BONUS_POINTS) : 20;
const REFERRAL_WELCOME_POINTS = Number(process.env.REFERRAL_WELCOME_POINTS) >= 0 ? Number(process.env.REFERRAL_WELCOME_POINTS) : 10;
const TOTP_MAX_ATTEMPTS = Number(process.env.TOTP_MAX_ATTEMPTS) > 0 ? Number(process.env.TOTP_MAX_ATTEMPTS) : 5;
const TOTP_LOCKOUT_MINUTES = Number(process.env.TOTP_LOCKOUT_MINUTES) > 0 ? Number(process.env.TOTP_LOCKOUT_MINUTES) : 5;
const TIER_SILVER_THRESHOLD = Number(process.env.TIER_SILVER_THRESHOLD) >= 0 ? Number(process.env.TIER_SILVER_THRESHOLD) : 100;
const TIER_GOLD_THRESHOLD = Number(process.env.TIER_GOLD_THRESHOLD) >= 0 ? Number(process.env.TIER_GOLD_THRESHOLD) : 300;
const SPIN_COOLDOWN_HOURS = Number(process.env.SPIN_COOLDOWN_HOURS) > 0 ? Number(process.env.SPIN_COOLDOWN_HOURS) : 24;

// ───────────────────────── suscripciones (pre-apertura) ─────────────────────────

const insertStmt = db.prepare(
  'INSERT INTO subscribers (nombre, telefono, dni, unasam) VALUES (?, ?, ?, ?)'
);
const countStmt = db.prepare('SELECT COUNT(*) AS total FROM subscribers');
const findByDniStmt = db.prepare('SELECT id FROM subscribers WHERE dni = ?');
const listStmt = db.prepare(
  'SELECT id, nombre, telefono, dni, unasam, created_at FROM subscribers ORDER BY id DESC'
);

function addSubscriber({ nombre, telefono, dni, unasam }) {
  insertStmt.run(nombre, telefono, dni, unasam);
}

function dniExists(dni) {
  return findByDniStmt.get(dni) !== undefined;
}

function getCount() {
  return countStmt.get().total;
}

function listSubscribers() {
  return listStmt.all();
}

// ───────────────────────── helpers ─────────────────────────

function paginate({ limit = 20, page = 1 } = {}) {
  const l = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const p = Math.max(Number(page) || 1, 1);
  return { limit: l, offset: (p - 1) * l, page: p };
}

function randomCode(length = 8) {
  return crypto.randomBytes(length).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, length).toUpperCase();
}

// ───────────────────────── usuarios / wallet ─────────────────────────

const getUserByGoogleIdStmt = db.prepare('SELECT * FROM users WHERE google_id = ?');
const getUserByIdStmt = db.prepare('SELECT * FROM users WHERE id = ?');
const getUserByEmailStmt = db.prepare('SELECT * FROM users WHERE email = ?');
const getUserByReferralCodeStmt = db.prepare('SELECT * FROM users WHERE referral_code = ?');
const insertUserStmt = db.prepare(
  `INSERT INTO users (google_id, email, name, avatar_url, referral_code)
   VALUES (?, ?, ?, ?, ?)`
);
const updateUserProfileStmt = db.prepare(
  'UPDATE users SET name = ?, avatar_url = ? WHERE id = ?'
);
const setUserContactStmt = db.prepare('UPDATE users SET dni = ?, telefono = ? WHERE id = ?');
const setReferredByStmt = db.prepare('UPDATE users SET referred_by = ? WHERE id = ? AND referred_by IS NULL');
const deleteAllSessionsForUserStmt = db.prepare('DELETE FROM sessions WHERE user_id = ?');
const setTotpSecretStmt = db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?');
const enableTotpStmt = db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?');
const setFamilyGroupStmt = db.prepare('UPDATE users SET family_group_id = ? WHERE id = ?');
const markWalletSavedStmt = db.prepare("UPDATE users SET wallet_saved_at = datetime('now') WHERE id = ?");
const listWalletSavedUserIdsStmt = db.prepare('SELECT id FROM users WHERE wallet_saved_at IS NOT NULL');
const setLastSpinStmt = db.prepare("UPDATE users SET last_spin_at = datetime('now') WHERE id = ?");

function upsertGoogleUser({ googleId, email, name, avatarUrl }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const existing = getUserByGoogleIdStmt.get(googleId);
  if (existing) {
    updateUserProfileStmt.run(name, avatarUrl || null, existing.id);
    return getUserByIdStmt.get(existing.id);
  }
  let referralCode;
  do {
    referralCode = randomCode(8);
  } while (getUserByReferralCodeStmt.get(referralCode));
  const info = insertUserStmt.run(googleId, cleanEmail, name, avatarUrl || null, referralCode);
  return getUserByIdStmt.get(info.lastInsertRowid);
}

function getUserById(id) {
  return getUserByIdStmt.get(id);
}

function getUserByEmail(email) {
  return getUserByEmailStmt.get(email);
}

function getUserByReferralCode(code) {
  return getUserByReferralCodeStmt.get(code);
}

// Vincula DNI y teléfono a la cuenta de wallet del cliente (Google no los
// entrega en el login — se piden aparte, ver server.js: /api/profile/complete).
// Es la base para poder cruzar más adelante con fecha de nacimiento y mandar
// promociones dirigidas (ej. cumpleaños) por WhatsApp/SMS.
function setUserContactInfo(userId, dni, telefono) {
  try {
    setUserContactStmt.run(dni, telefono, userId);
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed')) {
      throw new Error('DNI_TAKEN');
    }
    throw err;
  }
}

// Marca que el usuario abrió el link "Guardar en Google Wallet" — es la
// única señal que tenemos de que su loyaltyObject fue creado del lado de
// Google (la Wallet API no expone un endpoint para consultarlo).
function markWalletSaved(userId) {
  markWalletSavedStmt.run(userId);
}

function listWalletSavedUserIds() {
  return listWalletSavedUserIdsStmt.all().map((row) => row.id);
}

// Solo aplica (y solo paga el bono) la primera vez: setReferredByStmt tiene
// `AND referred_by IS NULL`, así que un segundo intento no vuelve a pagar.
function setReferredBy(userId, referrerId) {
  if (userId === referrerId) return false;
  const info = setReferredByStmt.run(referrerId, userId);
  if (info.changes === 0) return false;
  if (REFERRAL_BONUS_POINTS > 0) {
    insertLedgerStmt.run(referrerId, REFERRAL_BONUS_POINTS, `Bono por referir a un nuevo cliente`);
  }
  if (REFERRAL_WELCOME_POINTS > 0) {
    insertLedgerStmt.run(userId, REFERRAL_WELCOME_POINTS, 'Bono de bienvenida por registrarte con un código de referido');
  }
  return true;
}

function deleteAllSessionsForUser(userId) {
  deleteAllSessionsForUserStmt.run(userId);
}

function setTotpSecret(userId, secret) {
  setTotpSecretStmt.run(secret, userId);
}

function enableTotp(userId) {
  enableTotpStmt.run(userId);
}

// ───────────────────────── sesiones ─────────────────────────

const insertSessionStmt = db.prepare(
  'INSERT INTO sessions (token, user_id, stage, expires_at) VALUES (?, ?, ?, ?)'
);
const getSessionStmt = db.prepare('SELECT * FROM sessions WHERE token = ?');
const setSessionStageStmt = db.prepare('UPDATE sessions SET stage = ? WHERE token = ?');
const deleteSessionStmt = db.prepare('DELETE FROM sessions WHERE token = ?');
const deleteExpiredSessionsStmt = db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')");

const SESSION_TTL_DAYS = 30;

function createSession(userId, stage) {
  deleteExpiredSessionsStmt.run();
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString();
  insertSessionStmt.run(token, userId, stage, expiresAt);
  return token;
}

function getSession(token) {
  if (!token) return undefined;
  const session = getSessionStmt.get(token);
  if (!session) return undefined;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    deleteSessionStmt.run(token);
    return undefined;
  }
  return session;
}

function setSessionStage(token, stage) {
  setSessionStageStmt.run(stage, token);
}

function deleteSession(token) {
  deleteSessionStmt.run(token);
}

// ───────────────────────── bloqueo de intentos 2FA ─────────────────────────

const incrementTotpAttemptsStmt = db.prepare(
  `UPDATE sessions SET totp_attempts = totp_attempts + 1,
     totp_locked_until = CASE WHEN totp_attempts + 1 >= ? THEN datetime('now', ?) ELSE totp_locked_until END
   WHERE token = ?`
);
const resetTotpAttemptsStmt = db.prepare('UPDATE sessions SET totp_attempts = 0, totp_locked_until = NULL WHERE token = ?');

// SQLite datetime('now', ...) devuelve "YYYY-MM-DD HH:MM:SS" en UTC pero sin
// sufijo de zona horaria; hay que normalizarlo a ISO 8601 antes de comparar
// con `new Date()`, si no V8 lo interpreta como hora local.
function sqliteUtcToDate(value) {
  return new Date(`${value.replace(' ', 'T')}Z`);
}

function isTotpLocked(session) {
  return Boolean(session.totp_locked_until && sqliteUtcToDate(session.totp_locked_until) > new Date());
}

function registerTotpFailure(token) {
  incrementTotpAttemptsStmt.run(TOTP_MAX_ATTEMPTS, `+${TOTP_LOCKOUT_MINUTES} minutes`, token);
}

function resetTotpAttempts(token) {
  resetTotpAttemptsStmt.run(token);
}

// ───────────────────────── puntos / compras (consumo) ─────────────────────────

const insertPurchaseStmt = db.prepare(
  'INSERT INTO purchases (user_id, monto, producto, puntos) VALUES (?, ?, ?, ?)'
);
const insertLedgerStmt = db.prepare(
  'INSERT INTO points_ledger (user_id, delta, reason) VALUES (?, ?, ?)'
);
const balanceStmt = db.prepare(
  'SELECT COALESCE(SUM(delta), 0) AS balance FROM points_ledger WHERE user_id = ?'
);
const listPurchasesByUserStmt = db.prepare(
  `SELECT id, monto, producto, puntos, created_at FROM purchases
   WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`
);
const countPurchasesByUserStmt = db.prepare('SELECT COUNT(*) AS total FROM purchases WHERE user_id = ?');

function addPurchase({ userId, monto, producto }) {
  const puntos = Math.max(Math.floor(monto / SOLES_PER_PUNTO), 0);
  const info = insertPurchaseStmt.run(userId, monto, producto || null, puntos);
  if (puntos > 0) {
    insertLedgerStmt.run(userId, puntos, `Compra #${info.lastInsertRowid}`);
  }
  return { purchaseId: info.lastInsertRowid, puntos, balance: getPointsBalance(userId) };
}

function getPointsBalance(userId) {
  return balanceStmt.get(userId).balance;
}

function listPurchasesByUser(userId, { limit = 20, page = 1 } = {}) {
  const p = paginate({ limit, page });
  const items = listPurchasesByUserStmt.all(userId, p.limit, p.offset);
  const total = countPurchasesByUserStmt.get(userId).total;
  return { items, total, page: p.page, limit: p.limit };
}

function redeemPoints(userId, puntos, motivo) {
  const amount = Math.floor(Number(puntos));
  if (!(amount > 0)) throw new Error('INVALID_AMOUNT');
  if (getPointsBalance(userId) < amount) throw new Error('INSUFFICIENT_BALANCE');
  insertLedgerStmt.run(userId, -amount, motivo || 'Canje');
  return getPointsBalance(userId);
}

function getRewardProgress(userId) {
  const balance = getPointsBalance(userId);
  const inCycle = ((balance % REWARD_THRESHOLD) + REWARD_THRESHOLD) % REWARD_THRESHOLD;
  return {
    balance,
    threshold: REWARD_THRESHOLD,
    inCycle,
    remaining: Math.max(REWARD_THRESHOLD - inCycle, 0),
    progressPct: Math.round((inCycle / REWARD_THRESHOLD) * 100),
    rewardsAvailable: Math.floor(balance / REWARD_THRESHOLD),
  };
}

// ───────────────────────── niveles de fidelidad ─────────────────────────
//
// A diferencia del saldo canjeable (getPointsBalance, que baja al redimir),
// el nivel se calcula sobre los puntos ganados de por vida: canjear premios
// no debería hacerte "bajar de nivel".

const lifetimePointsStmt = db.prepare(
  'SELECT COALESCE(SUM(delta), 0) AS total FROM points_ledger WHERE user_id = ? AND delta > 0'
);

function getLifetimePoints(userId) {
  return lifetimePointsStmt.get(userId).total;
}

function tierForPoints(lifetimePoints) {
  if (lifetimePoints >= TIER_GOLD_THRESHOLD) {
    return { tier: 'oro', lifetimePoints, nextTier: null, pointsToNext: 0 };
  }
  if (lifetimePoints >= TIER_SILVER_THRESHOLD) {
    return {
      tier: 'plata',
      lifetimePoints,
      nextTier: 'oro',
      pointsToNext: TIER_GOLD_THRESHOLD - lifetimePoints,
    };
  }
  return {
    tier: 'bronce',
    lifetimePoints,
    nextTier: 'plata',
    pointsToNext: TIER_SILVER_THRESHOLD - lifetimePoints,
  };
}

function getTierForUser(userId) {
  return tierForPoints(getLifetimePoints(userId));
}

// ───────────────────────── ruleta de premios ─────────────────────────

const SPIN_PRIZES = [
  { label: 'Sigue participando', points: 0, weight: 10 },
  { label: '+5 estrellas', points: 5, weight: 40 },
  { label: '+10 estrellas', points: 10, weight: 30 },
  { label: '+20 estrellas', points: 20, weight: 15 },
  { label: '+50 estrellas', points: 50, weight: 5 },
];
const SPIN_WEIGHT_TOTAL = SPIN_PRIZES.reduce((sum, p) => sum + p.weight, 0);

function pickSpinPrize() {
  let roll = Math.random() * SPIN_WEIGHT_TOTAL;
  for (const prize of SPIN_PRIZES) {
    if (roll < prize.weight) return prize;
    roll -= prize.weight;
  }
  return SPIN_PRIZES[SPIN_PRIZES.length - 1];
}

function nextSpinAt(user) {
  if (!user.last_spin_at) return null;
  return new Date(sqliteUtcToDate(user.last_spin_at).getTime() + SPIN_COOLDOWN_HOURS * 3600_000);
}

function getSpinStatus(userId) {
  const next = nextSpinAt(getUserByIdStmt.get(userId));
  const available = !next || next <= new Date();
  return {
    available,
    nextSpinAt: available ? null : next.toISOString(),
    cooldownHours: SPIN_COOLDOWN_HOURS,
  };
}

function spinWheel(userId) {
  const user = getUserByIdStmt.get(userId);
  const next = nextSpinAt(user);
  if (next && next > new Date()) throw new Error('SPIN_COOLDOWN');

  const prize = pickSpinPrize();
  setLastSpinStmt.run(userId);
  if (prize.points > 0) {
    insertLedgerStmt.run(userId, prize.points, `Ruleta: ${prize.label}`);
  }
  return { prize, balance: getPointsBalance(userId), spinStatus: getSpinStatus(userId) };
}

// ───────────────────────── familia / compartidos ─────────────────────────

const insertFamilyGroupStmt = db.prepare(
  'INSERT INTO family_groups (name, owner_user_id, invite_code) VALUES (?, ?, ?)'
);
const getFamilyGroupByIdStmt = db.prepare('SELECT * FROM family_groups WHERE id = ?');
const getFamilyGroupByInviteCodeStmt = db.prepare('SELECT * FROM family_groups WHERE invite_code = ?');
const listFamilyMembersStmt = db.prepare(
  'SELECT id, name, email, avatar_url FROM users WHERE family_group_id = ?'
);

function createFamilyGroup(userId, name) {
  let inviteCode;
  do {
    inviteCode = randomCode(6);
  } while (getFamilyGroupByInviteCodeStmt.get(inviteCode));
  const info = insertFamilyGroupStmt.run(name, userId, inviteCode);
  setFamilyGroupStmt.run(info.lastInsertRowid, userId);
  return getFamilyGroupByIdStmt.get(info.lastInsertRowid);
}

function joinFamilyGroup(userId, inviteCode) {
  const group = getFamilyGroupByInviteCodeStmt.get(String(inviteCode || '').toUpperCase());
  if (!group) throw new Error('GROUP_NOT_FOUND');
  setFamilyGroupStmt.run(group.id, userId);
  return group;
}

function getFamilyGroupForUser(userId) {
  const user = getUserById(userId);
  if (!user || !user.family_group_id) return null;
  const group = getFamilyGroupByIdStmt.get(user.family_group_id);
  if (!group) return null;
  return { ...group, members: listFamilyMembersStmt.all(group.id) };
}

const clearFamilyGroupForAllMembersStmt = db.prepare('UPDATE users SET family_group_id = NULL WHERE family_group_id = ?');
const deleteFamilyGroupStmt = db.prepare('DELETE FROM family_groups WHERE id = ?');

// Si sale el dueño, el grupo se disuelve para todos (no hay a quién
// transferir la propiedad); si sale un miembro normal, solo él se va.
function leaveFamilyGroup(userId) {
  const user = getUserById(userId);
  if (!user || !user.family_group_id) throw new Error('NOT_IN_GROUP');
  const group = getFamilyGroupByIdStmt.get(user.family_group_id);

  if (group.owner_user_id === userId) {
    clearFamilyGroupForAllMembersStmt.run(group.id);
    deleteFamilyGroupStmt.run(group.id);
    return { disbanded: true };
  }
  setFamilyGroupStmt.run(null, userId);
  return { disbanded: false };
}

function removeFamilyMember(ownerId, memberUserId) {
  const owner = getUserById(ownerId);
  if (!owner || !owner.family_group_id) throw new Error('NOT_IN_GROUP');
  const group = getFamilyGroupByIdStmt.get(owner.family_group_id);
  if (!group || group.owner_user_id !== ownerId) throw new Error('NOT_OWNER');
  if (Number(memberUserId) === Number(ownerId)) throw new Error('CANNOT_REMOVE_SELF');

  const member = getUserById(memberUserId);
  if (!member || member.family_group_id !== group.id) throw new Error('NOT_A_MEMBER');
  setFamilyGroupStmt.run(null, memberUserId);
}

// ───────────────────────── catálogo de productos ─────────────────────────

const insertProductStmt = db.prepare(
  'INSERT INTO products (name, photo_url, price) VALUES (?, ?, ?)'
);
const getProductByIdStmt = db.prepare('SELECT * FROM products WHERE id = ?');
const listActiveProductsStmt = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY name');
const adminListProductsStmt = db.prepare('SELECT * FROM products ORDER BY id DESC LIMIT ? OFFSET ?');
const adminProductsCountStmt = db.prepare('SELECT COUNT(*) AS total FROM products');
const deactivateProductStmt = db.prepare('UPDATE products SET active = 0 WHERE id = ?');

function createProduct({ name, photoUrl, price }) {
  const info = insertProductStmt.run(name, photoUrl || null, price != null && price !== '' ? Number(price) : null);
  return getProductByIdStmt.get(info.lastInsertRowid);
}

function getProductById(id) {
  return getProductByIdStmt.get(id);
}

function listActiveProducts() {
  return listActiveProductsStmt.all();
}

function adminListProducts({ limit = 20, page = 1 } = {}) {
  const p = paginate({ limit, page });
  return {
    items: adminListProductsStmt.all(p.limit, p.offset),
    total: adminProductsCountStmt.get().total,
    page: p.page,
    limit: p.limit,
  };
}

function deactivateProduct(id) {
  deactivateProductStmt.run(id);
}

const updateProductStmt = db.prepare('UPDATE products SET name = ?, photo_url = ?, price = ? WHERE id = ?');
const countPromotionProductsForProductStmt = db.prepare('SELECT COUNT(*) AS total FROM promotion_products WHERE product_id = ?');
const deleteProductStmt = db.prepare('DELETE FROM products WHERE id = ?');

function updateProduct(id, { name, photoUrl, price }) {
  const existing = getProductByIdStmt.get(id);
  if (!existing) throw new Error('PRODUCT_NOT_FOUND');
  updateProductStmt.run(
    name != null && name !== '' ? name : existing.name,
    photoUrl !== undefined ? (photoUrl || null) : existing.photo_url,
    price !== undefined ? (price != null && price !== '' ? Number(price) : null) : existing.price,
    id
  );
  return getProductByIdStmt.get(id);
}

// Borrado real solo si el producto no está asociado a ninguna promoción; si
// lo está, hay que desactivarlo en vez de borrarlo (no rompe el historial).
function deleteProduct(id) {
  if (countPromotionProductsForProductStmt.get(id).total > 0) throw new Error('PRODUCT_IN_USE');
  const info = deleteProductStmt.run(id);
  if (info.changes === 0) throw new Error('PRODUCT_NOT_FOUND');
}

// ───────────────────────── promociones ─────────────────────────

const insertPromotionStmt = db.prepare(
  'INSERT INTO promotions (title, body, photo_url, starts_at, ends_at, publication_code) VALUES (?, ?, ?, ?, ?, ?)'
);
const getPromotionByIdStmt = db.prepare('SELECT * FROM promotions WHERE id = ?');
const listActivePromotionsRawStmt = db.prepare(
  `SELECT * FROM promotions
   WHERE active = 1
     AND (starts_at IS NULL OR starts_at <= datetime('now'))
     AND (ends_at IS NULL OR ends_at >= datetime('now'))
   ORDER BY id DESC LIMIT 5`
);
const adminListPromotionsStmt = db.prepare(
  'SELECT * FROM promotions ORDER BY id DESC LIMIT ? OFFSET ?'
);
const adminPromotionsCountStmt = db.prepare('SELECT COUNT(*) AS total FROM promotions');
const deactivatePromotionStmt = db.prepare('UPDATE promotions SET active = 0 WHERE id = ?');
const markPromotionPushedStmt = db.prepare('UPDATE promotions SET pushed_to = ? WHERE id = ?');

const insertPromotionProductStmt = db.prepare(
  'INSERT OR IGNORE INTO promotion_products (promotion_id, product_id) VALUES (?, ?)'
);
const listPromotionProductsStmt = db.prepare(
  `SELECT pr.* FROM promotion_products pp
   JOIN products pr ON pr.id = pp.product_id
   WHERE pp.promotion_id = ?
   ORDER BY pr.name`
);

const insertPromotionCodeStmt = db.prepare(
  'INSERT INTO promotion_codes (promotion_id, code, label, max_uses) VALUES (?, ?, ?, ?)'
);
const listPromotionCodesStmt = db.prepare(
  'SELECT * FROM promotion_codes WHERE promotion_id = ? ORDER BY id'
);
const getPromotionCodeByCodeStmt = db.prepare('SELECT * FROM promotion_codes WHERE code = ?');
const incrementPromotionCodeUsesStmt = db.prepare(
  'UPDATE promotion_codes SET uses_count = uses_count + 1 WHERE id = ?'
);
const insertPromotionRedemptionStmt = db.prepare(
  'INSERT INTO promotion_redemptions (promotion_code_id, user_id) VALUES (?, ?)'
);

function generatePublicationCode(promotionId) {
  return `PROMO-${String(promotionId).padStart(4, '0')}`;
}

// Uso interno/admin: incluye los códigos de canje (uso interno del staff).
function hydratePromotion(promotion) {
  if (!promotion) return promotion;
  return {
    ...promotion,
    products: listPromotionProductsStmt.all(promotion.id),
    codes: listPromotionCodesStmt.all(promotion.id),
  };
}

// Uso público (cliente): NO expone los códigos de canje — el cliente debe
// obtenerlos por el canal donde se distribuya la promo (flyer, redes, etc.)
// y canjearlos a mano; listarlos aquí los filtraría a cualquiera con sesión.
function hydratePromotionPublic(promotion) {
  if (!promotion) return promotion;
  return { ...promotion, products: listPromotionProductsStmt.all(promotion.id) };
}

function createPromotion({ title, body, photoUrl, startsAt, endsAt, productIds = [] }) {
  const info = insertPromotionStmt.run(title, body, photoUrl || null, startsAt || null, endsAt || null, null);
  const id = info.lastInsertRowid;
  db.prepare('UPDATE promotions SET publication_code = ? WHERE id = ?').run(generatePublicationCode(id), id);
  for (const productId of productIds) {
    insertPromotionProductStmt.run(id, productId);
  }
  return hydratePromotion(getPromotionByIdStmt.get(id));
}

function addPromotionCode(promotionId, { code, label, maxUses }) {
  const cleanCode = String(code || '').trim().toUpperCase() || randomCode(8);
  insertPromotionCodeStmt.run(promotionId, cleanCode, label || null, maxUses ? Number(maxUses) : null);
  return hydratePromotion(getPromotionByIdStmt.get(promotionId));
}

function redeemPromotionCode(code, userId) {
  const promoCode = getPromotionCodeByCodeStmt.get(String(code || '').trim().toUpperCase());
  if (!promoCode) throw new Error('CODE_NOT_FOUND');

  const promotion = getPromotionByIdStmt.get(promoCode.promotion_id);
  if (!promotion || !promotion.active) throw new Error('PROMOTION_INACTIVE');
  const now = new Date();
  if (promotion.starts_at && new Date(promotion.starts_at) > now) throw new Error('PROMOTION_NOT_STARTED');
  if (promotion.ends_at && new Date(promotion.ends_at) < now) throw new Error('PROMOTION_EXPIRED');
  if (promoCode.max_uses != null && promoCode.uses_count >= promoCode.max_uses) throw new Error('CODE_EXHAUSTED');

  incrementPromotionCodeUsesStmt.run(promoCode.id);
  insertPromotionRedemptionStmt.run(promoCode.id, userId);
  // Solo se devuelve el código canjeado, no el resto de códigos de la
  // promoción (podrían ser de otra sucursal/tanda y no le corresponden a este cliente).
  return {
    promotion: hydratePromotionPublic(promotion),
    code: { label: promoCode.label, usesRemaining: promoCode.max_uses != null ? promoCode.max_uses - (promoCode.uses_count + 1) : null },
  };
}

function listActivePromotions() {
  return listActivePromotionsRawStmt.all().map(hydratePromotionPublic);
}

function adminListPromotions({ limit = 20, page = 1 } = {}) {
  const p = paginate({ limit, page });
  return {
    items: adminListPromotionsStmt.all(p.limit, p.offset).map(hydratePromotion),
    total: adminPromotionsCountStmt.get().total,
    page: p.page,
    limit: p.limit,
  };
}

function deactivatePromotion(id) {
  deactivatePromotionStmt.run(id);
}

function markPromotionPushed(id, count) {
  markPromotionPushedStmt.run(count, id);
}

const updatePromotionStmt = db.prepare(
  'UPDATE promotions SET title = ?, body = ?, photo_url = ?, starts_at = ?, ends_at = ? WHERE id = ?'
);
const deletePromotionProductsStmt = db.prepare('DELETE FROM promotion_products WHERE promotion_id = ?');
const countPromotionRedemptionsStmt = db.prepare(
  `SELECT COUNT(*) AS total FROM promotion_redemptions r
   JOIN promotion_codes c ON c.id = r.promotion_code_id
   WHERE c.promotion_id = ?`
);
const deletePromotionCodesStmt = db.prepare('DELETE FROM promotion_codes WHERE promotion_id = ?');
const deletePromotionStmt = db.prepare('DELETE FROM promotions WHERE id = ?');

function updatePromotion(id, { title, body, photoUrl, startsAt, endsAt, productIds }) {
  const existing = getPromotionByIdStmt.get(id);
  if (!existing) throw new Error('PROMOTION_NOT_FOUND');
  updatePromotionStmt.run(
    title != null && title !== '' ? title : existing.title,
    body != null && body !== '' ? body : existing.body,
    photoUrl !== undefined ? (photoUrl || null) : existing.photo_url,
    startsAt !== undefined ? (startsAt || null) : existing.starts_at,
    endsAt !== undefined ? (endsAt || null) : existing.ends_at,
    id
  );
  if (productIds !== undefined) {
    deletePromotionProductsStmt.run(id);
    for (const productId of productIds) insertPromotionProductStmt.run(id, productId);
  }
  return hydratePromotion(getPromotionByIdStmt.get(id));
}

// Borrado real solo si nadie canjeó ningún código de esta promoción (si no,
// se pierde el historial de canjes); si ya se usó, hay que desactivarla.
function deletePromotion(id) {
  if (countPromotionRedemptionsStmt.get(id).total > 0) throw new Error('PROMOTION_HAS_REDEMPTIONS');
  deletePromotionProductsStmt.run(id);
  deletePromotionCodesStmt.run(id);
  const info = deletePromotionStmt.run(id);
  if (info.changes === 0) throw new Error('PROMOTION_NOT_FOUND');
}

// ───────────────────────── notificaciones push ─────────────────────────

const upsertPushSubscriptionStmt = db.prepare(
  `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
   ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
);
const deletePushSubscriptionStmt = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
const listAllPushSubscriptionsStmt = db.prepare('SELECT * FROM push_subscriptions');
const listPushSubscriptionsByUserStmt = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?');
const countPushSubscriptionsStmt = db.prepare('SELECT COUNT(*) AS total FROM push_subscriptions');

function addPushSubscription(userId, { endpoint, p256dh, auth }) {
  upsertPushSubscriptionStmt.run(userId, endpoint, p256dh, auth);
}

function removePushSubscription(endpoint) {
  deletePushSubscriptionStmt.run(endpoint);
}

function listAllPushSubscriptions() {
  return listAllPushSubscriptionsStmt.all();
}

function listPushSubscriptionsByUser(userId) {
  return listPushSubscriptionsByUserStmt.all(userId);
}

function countPushSubscriptions() {
  return countPushSubscriptionsStmt.get().total;
}

// ───────────────────────── panel administrador ─────────────────────────

const adminUsersStmt = db.prepare(
  `SELECT u.id, u.name, u.email, u.avatar_url, u.totp_enabled, u.created_at,
          u.dni, u.telefono,
          u.referred_by, u.family_group_id,
          COALESCE((SELECT SUM(delta) FROM points_ledger l WHERE l.user_id = u.id), 0) AS puntos,
          COALESCE((SELECT SUM(monto) FROM purchases p WHERE p.user_id = u.id), 0) AS total_gastado,
          COALESCE((SELECT COUNT(*) FROM purchases p WHERE p.user_id = u.id), 0) AS num_compras
   FROM users u
   ORDER BY u.created_at DESC
   LIMIT ? OFFSET ?`
);
const adminUsersCountStmt = db.prepare('SELECT COUNT(*) AS total FROM users');

function adminListUsers({ limit = 20, page = 1, q } = {}) {
  const p = paginate({ limit, page });
  if (!q) {
    return {
      items: adminUsersStmt.all(p.limit, p.offset),
      total: adminUsersCountStmt.get().total,
      page: p.page,
      limit: p.limit,
    };
  }
  const search = `%${q}%`;
  const stmt = db.prepare(`
    SELECT u.id, u.name, u.email, u.avatar_url, u.totp_enabled, u.created_at,
           u.dni, u.telefono,
           u.referred_by, u.family_group_id,
           COALESCE((SELECT SUM(delta) FROM points_ledger l WHERE l.user_id = u.id), 0) AS puntos,
           COALESCE((SELECT SUM(monto) FROM purchases p WHERE p.user_id = u.id), 0) AS total_gastado,
           COALESCE((SELECT COUNT(*) FROM purchases p WHERE p.user_id = u.id), 0) AS num_compras
    FROM users u
    WHERE u.name LIKE ? OR u.email LIKE ?
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `);
  const countStmt = db.prepare('SELECT COUNT(*) AS total FROM users WHERE name LIKE ? OR email LIKE ?');
  return {
    items: stmt.all(search, search, p.limit, p.offset),
    total: countStmt.get(search, search).total,
    page: p.page,
    limit: p.limit,
  };
}

const adminReferralsStmt = db.prepare(
  `SELECT u.id, u.name, u.email, u.created_at AS fecha_registro,
          r.id AS referrer_id, r.name AS referrer_name, r.email AS referrer_email,
          COALESCE((SELECT COUNT(*) FROM purchases p WHERE p.user_id = u.id), 0) AS num_compras,
          COALESCE((SELECT SUM(delta) FROM points_ledger l WHERE l.user_id = u.id), 0) AS puntos
   FROM users u
   JOIN users r ON r.id = u.referred_by
   ORDER BY u.created_at DESC
   LIMIT ? OFFSET ?`
);
const adminReferralsCountStmt = db.prepare('SELECT COUNT(*) AS total FROM users WHERE referred_by IS NOT NULL');

function adminListReferrals({ limit = 20, page = 1, q } = {}) {
  const p = paginate({ limit, page });
  if (!q) {
    return {
      items: adminReferralsStmt.all(p.limit, p.offset),
      total: adminReferralsCountStmt.get().total,
      page: p.page,
      limit: p.limit,
    };
  }
  const search = `%${q}%`;
  const stmt = db.prepare(`
    SELECT u.id, u.name, u.email, u.created_at AS fecha_registro,
           r.id AS referrer_id, r.name AS referrer_name, r.email AS referrer_email,
           COALESCE((SELECT COUNT(*) FROM purchases p WHERE p.user_id = u.id), 0) AS num_compras,
           COALESCE((SELECT SUM(delta) FROM points_ledger l WHERE l.user_id = u.id), 0) AS puntos
    FROM users u
    JOIN users r ON r.id = u.referred_by
    WHERE u.name LIKE ? OR u.email LIKE ? OR r.name LIKE ? OR r.email LIKE ?
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `);
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS total FROM users u JOIN users r ON r.id = u.referred_by
     WHERE u.name LIKE ? OR u.email LIKE ? OR r.name LIKE ? OR r.email LIKE ?`
  );
  return {
    items: stmt.all(search, search, search, search, p.limit, p.offset),
    total: countStmt.get(search, search, search, search).total,
    page: p.page,
    limit: p.limit,
  };
}

const adminFamilyGroupsStmt = db.prepare(
  `SELECT g.id, g.name, g.invite_code, g.created_at, o.name AS owner_name, o.email AS owner_email,
          (SELECT COUNT(*) FROM users u WHERE u.family_group_id = g.id) AS num_miembros
   FROM family_groups g
   JOIN users o ON o.id = g.owner_user_id
   ORDER BY g.created_at DESC
   LIMIT ? OFFSET ?`
);
const adminFamilyGroupsCountStmt = db.prepare('SELECT COUNT(*) AS total FROM family_groups');

function adminListFamilyGroups({ limit = 20, page = 1 } = {}) {
  const p = paginate({ limit, page });
  const items = adminFamilyGroupsStmt.all(p.limit, p.offset).map((g) => ({
    ...g,
    members: listFamilyMembersStmt.all(g.id),
  }));
  return {
    items,
    total: adminFamilyGroupsCountStmt.get().total,
    page: p.page,
    limit: p.limit,
  };
}

const adminPurchasesStmt = db.prepare(
  `SELECT p.id, p.monto, p.producto, p.puntos, p.created_at, u.name AS user_name, u.email AS user_email
   FROM purchases p
   JOIN users u ON u.id = p.user_id
   ORDER BY p.id DESC
   LIMIT ? OFFSET ?`
);
const adminPurchasesCountStmt = db.prepare('SELECT COUNT(*) AS total FROM purchases');

function adminListPurchases({ limit = 20, page = 1, q } = {}) {
  const p = paginate({ limit, page });
  if (!q) {
    return {
      items: adminPurchasesStmt.all(p.limit, p.offset),
      total: adminPurchasesCountStmt.get().total,
      page: p.page,
      limit: p.limit,
    };
  }
  const search = `%${q}%`;
  const stmt = db.prepare(`
    SELECT p.id, p.monto, p.producto, p.puntos, p.created_at, u.name AS user_name, u.email AS user_email
    FROM purchases p
    JOIN users u ON u.id = p.user_id
    WHERE u.name LIKE ? OR u.email LIKE ? OR p.producto LIKE ?
    ORDER BY p.id DESC
    LIMIT ? OFFSET ?
  `);
  const countStmt = db.prepare(
    `SELECT COUNT(*) AS total FROM purchases p JOIN users u ON u.id = p.user_id
     WHERE u.name LIKE ? OR u.email LIKE ? OR p.producto LIKE ?`
  );
  return {
    items: stmt.all(search, search, search, p.limit, p.offset),
    total: countStmt.get(search, search, search).total,
    page: p.page,
    limit: p.limit,
  };
}

const trafficByHourStmt = db.prepare(
  `SELECT CAST(strftime('%H', created_at) AS INTEGER) AS hora, COUNT(*) AS total, COALESCE(SUM(monto),0) AS monto
   FROM purchases GROUP BY hora ORDER BY hora`
);
const trafficByWeekdayStmt = db.prepare(
  `SELECT CAST(strftime('%w', created_at) AS INTEGER) AS dia, COUNT(*) AS total, COALESCE(SUM(monto),0) AS monto
   FROM purchases GROUP BY dia ORDER BY dia`
);

const WEEKDAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function adminAllUsers() {
  return adminUsersStmt.all(-1, 0);
}

function adminAllPurchases() {
  return adminPurchasesStmt.all(-1, 0);
}

function adminAllReferrals() {
  return adminReferralsStmt.all(-1, 0);
}

function adminTrafficStats() {
  const byHourRaw = trafficByHourStmt.all();
  const byHour = Array.from({ length: 24 }, (_, hora) => {
    const row = byHourRaw.find((r) => r.hora === hora);
    return { hora, total: row ? row.total : 0, monto: row ? row.monto : 0 };
  });

  const byWeekdayRaw = trafficByWeekdayStmt.all();
  const byWeekday = WEEKDAY_NAMES.map((nombre, dia) => {
    const row = byWeekdayRaw.find((r) => r.dia === dia);
    return { dia, nombre, total: row ? row.total : 0, monto: row ? row.monto : 0 };
  });

  return { byHour, byWeekday };
}

module.exports = {
  // suscripciones pre-apertura
  addSubscriber,
  dniExists,
  getCount,
  listSubscribers,
  // usuarios / wallet
  upsertGoogleUser,
  getUserById,
  getUserByEmail,
  getUserByReferralCode,
  setReferredBy,
  setUserContactInfo,
  setTotpSecret,
  enableTotp,
  markWalletSaved,
  listWalletSavedUserIds,
  // sesiones
  createSession,
  getSession,
  setSessionStage,
  deleteSession,
  deleteAllSessionsForUser,
  isTotpLocked,
  registerTotpFailure,
  resetTotpAttempts,
  TOTP_MAX_ATTEMPTS,
  TOTP_LOCKOUT_MINUTES,
  // puntos / compras
  addPurchase,
  getPointsBalance,
  listPurchasesByUser,
  redeemPoints,
  getRewardProgress,
  SOLES_PER_PUNTO,
  REWARD_THRESHOLD,
  REFERRAL_BONUS_POINTS,
  REFERRAL_WELCOME_POINTS,
  // niveles de fidelidad
  getLifetimePoints,
  getTierForUser,
  TIER_SILVER_THRESHOLD,
  TIER_GOLD_THRESHOLD,
  // ruleta de premios
  spinWheel,
  getSpinStatus,
  SPIN_COOLDOWN_HOURS,
  // familia
  createFamilyGroup,
  joinFamilyGroup,
  getFamilyGroupForUser,
  leaveFamilyGroup,
  removeFamilyMember,
  // productos
  createProduct,
  getProductById,
  listActiveProducts,
  adminListProducts,
  deactivateProduct,
  updateProduct,
  deleteProduct,
  // promociones
  createPromotion,
  addPromotionCode,
  redeemPromotionCode,
  listActivePromotions,
  adminListPromotions,
  deactivatePromotion,
  markPromotionPushed,
  updatePromotion,
  deletePromotion,
  // push
  addPushSubscription,
  removePushSubscription,
  listAllPushSubscriptions,
  listPushSubscriptionsByUser,
  countPushSubscriptions,
  // admin
  adminListUsers,
  adminListReferrals,
  adminListFamilyGroups,
  adminListPurchases,
  adminTrafficStats,
  adminAllUsers,
  adminAllPurchases,
  adminAllReferrals,
};
