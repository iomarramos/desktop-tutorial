const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'suscripciones.sqlite');

fs.mkdirSync(DATA_DIR, { recursive: true });

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

db.exec('CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_ledger_user ON points_ledger(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id)');

const SOLES_PER_PUNTO = Number(process.env.SOLES_PER_PUNTO) > 0 ? Number(process.env.SOLES_PER_PUNTO) : 5;
const REWARD_THRESHOLD = Number(process.env.REWARD_THRESHOLD) > 0 ? Number(process.env.REWARD_THRESHOLD) : 50;

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
const setReferredByStmt = db.prepare('UPDATE users SET referred_by = ? WHERE id = ? AND referred_by IS NULL');
const setTotpSecretStmt = db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?');
const enableTotpStmt = db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?');
const setFamilyGroupStmt = db.prepare('UPDATE users SET family_group_id = ? WHERE id = ?');

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

function setReferredBy(userId, referrerId) {
  if (userId === referrerId) return;
  setReferredByStmt.run(referrerId, userId);
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

// ───────────────────────── promociones ─────────────────────────

const insertPromotionStmt = db.prepare(
  'INSERT INTO promotions (title, body) VALUES (?, ?)'
);
const getPromotionByIdStmt = db.prepare('SELECT * FROM promotions WHERE id = ?');
const listActivePromotionsStmt = db.prepare(
  'SELECT id, title, body, created_at FROM promotions WHERE active = 1 ORDER BY id DESC LIMIT 5'
);
const adminListPromotionsStmt = db.prepare(
  'SELECT * FROM promotions ORDER BY id DESC LIMIT ? OFFSET ?'
);
const adminPromotionsCountStmt = db.prepare('SELECT COUNT(*) AS total FROM promotions');
const deactivatePromotionStmt = db.prepare('UPDATE promotions SET active = 0 WHERE id = ?');
const markPromotionPushedStmt = db.prepare('UPDATE promotions SET pushed_to = ? WHERE id = ?');

function createPromotion({ title, body }) {
  const info = insertPromotionStmt.run(title, body);
  return getPromotionByIdStmt.get(info.lastInsertRowid);
}

function listActivePromotions() {
  return listActivePromotionsStmt.all();
}

function adminListPromotions({ limit = 20, page = 1 } = {}) {
  const p = paginate({ limit, page });
  return {
    items: adminListPromotionsStmt.all(p.limit, p.offset),
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
  setTotpSecret,
  enableTotp,
  // sesiones
  createSession,
  getSession,
  setSessionStage,
  deleteSession,
  // puntos / compras
  addPurchase,
  getPointsBalance,
  listPurchasesByUser,
  redeemPoints,
  getRewardProgress,
  SOLES_PER_PUNTO,
  REWARD_THRESHOLD,
  // familia
  createFamilyGroup,
  joinFamilyGroup,
  getFamilyGroupForUser,
  // promociones
  createPromotion,
  listActivePromotions,
  adminListPromotions,
  deactivatePromotion,
  markPromotionPushed,
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
