// Cada archivo de test corre en su propio proceso con `node --test`, así
// que fijar DB_FILE aquí antes de requerir '../db' no interfiere con otros
// archivos de test ni con la base de datos de desarrollo.
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const TMP_DB = path.join(os.tmpdir(), `desencajado-test-db-${process.pid}-${Date.now()}.sqlite`);
process.env.DB_FILE = TMP_DB;
process.env.SOLES_PER_PUNTO = '5';
process.env.REWARD_THRESHOLD = '50';
process.env.REFERRAL_BONUS_POINTS = '20';
process.env.REFERRAL_WELCOME_POINTS = '10';
process.env.TOTP_MAX_ATTEMPTS = '5';
process.env.TOTP_LOCKOUT_MINUTES = '5';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');

after(() => {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    fs.rmSync(TMP_DB + suffix, { force: true });
  }
});

let userSeq = 0;
function makeUser(name) {
  userSeq += 1;
  return db.upsertGoogleUser({
    googleId: `g${userSeq}`,
    email: `user${userSeq}@example.com`,
    name,
    avatarUrl: null,
  });
}

// ───────────────────────── referidos ─────────────────────────

test('referidos: paga bono al referidor y al referido, una sola vez', () => {
  const ana = makeUser('Ana');
  const luis = makeUser('Luis');

  assert.equal(db.getPointsBalance(ana.id), 0);
  assert.equal(db.setReferredBy(luis.id, ana.id), true);
  assert.equal(db.getPointsBalance(ana.id), 20);
  assert.equal(db.getPointsBalance(luis.id), 10);

  // segundo intento no debe volver a pagar
  assert.equal(db.setReferredBy(luis.id, ana.id), false);
  assert.equal(db.getPointsBalance(ana.id), 20);
});

test('referidos: no se puede uno referir a sí mismo', () => {
  const carla = makeUser('Carla');
  assert.equal(db.setReferredBy(carla.id, carla.id), false);
});

// ───────────────────────── grupo familiar ─────────────────────────

test('familia: crear, unirse, expulsar y salir', () => {
  const owner = makeUser('Dueña');
  const member = makeUser('Miembro');
  const other = makeUser('Otro');

  const group = db.createFamilyGroup(owner.id, 'Familia Test');
  db.joinFamilyGroup(member.id, group.invite_code);

  const withMembers = db.getFamilyGroupForUser(owner.id);
  assert.equal(withMembers.members.length, 2);

  assert.throws(() => db.removeFamilyMember(member.id, owner.id), /NOT_OWNER/);
  db.removeFamilyMember(owner.id, member.id);
  assert.equal(db.getUserById(member.id).family_group_id, null);

  db.joinFamilyGroup(member.id, group.invite_code);
  const leaveNonOwner = db.leaveFamilyGroup(member.id);
  assert.equal(leaveNonOwner.disbanded, false);
  assert.equal(db.getUserById(member.id).family_group_id, null);
  assert.notEqual(db.getUserById(owner.id).family_group_id, null);

  const leaveOwner = db.leaveFamilyGroup(owner.id);
  assert.equal(leaveOwner.disbanded, true);
  assert.equal(db.getUserById(owner.id).family_group_id, null);

  assert.throws(() => db.leaveFamilyGroup(other.id), /NOT_IN_GROUP/);
});

// ───────────────────────── productos ─────────────────────────

test('productos: crear, editar, y bloquear borrado si está en uso', () => {
  const product = db.createProduct({ name: 'Frappé', photoUrl: null, price: 15 });
  const updated = db.updateProduct(product.id, { name: 'Frappé de Lúcuma', price: 18.5 });
  assert.equal(updated.name, 'Frappé de Lúcuma');
  assert.equal(updated.price, 18.5);

  const promo = db.createPromotion({ title: 'Promo', body: 'x', productIds: [product.id] });
  assert.throws(() => db.deleteProduct(product.id), /PRODUCT_IN_USE/);

  db.deletePromotion(promo.id);
  db.deleteProduct(product.id);
  assert.equal(db.getProductById(product.id), undefined);
});

// ───────────────────────── promociones y canje ─────────────────────────

test('promociones: código de publicación autogenerado y edición', () => {
  const promo = db.createPromotion({ title: 'Original', body: 'Texto' });
  assert.match(promo.publication_code, /^PROMO-\d{4}$/);

  const edited = db.updatePromotion(promo.id, { title: 'Editado' });
  assert.equal(edited.title, 'Editado');
  assert.equal(edited.body, 'Texto');
});

test('canje: valida código inexistente, vigencia y límite de usos', () => {
  const user = makeUser('Redimidor');
  const promo = db.createPromotion({ title: 'Con canje', body: 'x' });
  db.addPromotionCode(promo.id, { code: 'LIMITADO', label: 'Centro', maxUses: 2 });

  assert.throws(() => db.redeemPromotionCode('NOEXISTE', user.id), /CODE_NOT_FOUND/);

  const r1 = db.redeemPromotionCode('limitado', user.id);
  assert.equal(r1.code.usesRemaining, 1);
  assert.equal(r1.promotion.codes, undefined); // no debe filtrar la lista de códigos

  db.redeemPromotionCode('LIMITADO', user.id);
  assert.throws(() => db.redeemPromotionCode('LIMITADO', user.id), /CODE_EXHAUSTED/);
});

test('canje: rechaza promoción fuera de vigencia', () => {
  const user = makeUser('Fuera de fecha');
  const expired = db.createPromotion({
    title: 'Vencida',
    body: 'x',
    startsAt: '2000-01-01 00:00:00',
    endsAt: '2000-01-02 00:00:00',
  });
  db.addPromotionCode(expired.id, { code: 'VENCIDO', label: null, maxUses: null });
  assert.throws(() => db.redeemPromotionCode('VENCIDO', user.id), /PROMOTION_EXPIRED/);
});

test('promociones: no se puede borrar una promoción con canjes', () => {
  const user = makeUser('Con canje previo');
  const promo = db.createPromotion({ title: 'Con historial', body: 'x' });
  db.addPromotionCode(promo.id, { code: 'HIST', label: null, maxUses: null });
  db.redeemPromotionCode('HIST', user.id);
  assert.throws(() => db.deletePromotion(promo.id), /PROMOTION_HAS_REDEMPTIONS/);
});

// ───────────────────────── puntos / recompensas ─────────────────────────

test('compras: calcula estrellas según SOLES_PER_PUNTO y actualiza el balance', () => {
  const user = makeUser('Comprador');
  const result = db.addPurchase({ userId: user.id, monto: 27, producto: 'Café' });
  assert.equal(result.puntos, 5); // floor(27 / 5)
  assert.equal(result.balance, 5);
});

test('canje de puntos: rechaza monto inválido o saldo insuficiente', () => {
  const user = makeUser('Canjeador');
  db.addPurchase({ userId: user.id, monto: 50, producto: 'x' }); // +10 puntos
  assert.throws(() => db.redeemPoints(user.id, 0, 'x'), /INVALID_AMOUNT/);
  assert.throws(() => db.redeemPoints(user.id, 100, 'x'), /INSUFFICIENT_BALANCE/);
  const balance = db.redeemPoints(user.id, 4, 'Frappé');
  assert.equal(balance, 6);
});

test('progreso de recompensa: calcula ciclo y recompensas disponibles', () => {
  const user = makeUser('Progreso');
  db.addPurchase({ userId: user.id, monto: 255, producto: 'x' }); // 51 puntos con SOLES_PER_PUNTO=5
  const progress = db.getRewardProgress(user.id);
  assert.equal(progress.balance, 51);
  assert.equal(progress.threshold, 50);
  assert.equal(progress.inCycle, 1);
  assert.equal(progress.remaining, 49);
  assert.equal(progress.rewardsAvailable, 1);
});

// ───────────────────────── 2FA: bloqueo de intentos ─────────────────────────

test('2FA: bloquea tras el máximo de intentos y se resetea', () => {
  const user = makeUser('Con 2FA');
  const token = db.createSession(user.id, 'pending_2fa');

  for (let i = 0; i < 4; i++) {
    db.registerTotpFailure(token);
    assert.equal(db.isTotpLocked(db.getSession(token)), false);
  }
  db.registerTotpFailure(token); // 5to intento: bloquea
  assert.equal(db.isTotpLocked(db.getSession(token)), true);

  db.resetTotpAttempts(token);
  assert.equal(db.isTotpLocked(db.getSession(token)), false);
});

// ───────────────────────── sesiones ─────────────────────────

test('sesiones: deleteAllSessionsForUser revoca todas las sesiones del usuario', () => {
  const user = makeUser('Multi sesión');
  const t1 = db.createSession(user.id, 'active');
  const t2 = db.createSession(user.id, 'active');
  assert.ok(db.getSession(t1));
  assert.ok(db.getSession(t2));

  db.deleteAllSessionsForUser(user.id);
  assert.equal(db.getSession(t1), undefined);
  assert.equal(db.getSession(t2), undefined);
});

// ───────────────────────── Google Wallet ─────────────────────────

test('wallet: markWalletSaved agrega al usuario a listWalletSavedUserIds', () => {
  const before = makeUser('Sin wallet guardada');
  const after1 = makeUser('Con wallet guardada');

  assert.ok(!db.listWalletSavedUserIds().includes(before.id));
  assert.ok(!db.listWalletSavedUserIds().includes(after1.id));

  db.markWalletSaved(after1.id);

  assert.ok(!db.listWalletSavedUserIds().includes(before.id));
  assert.ok(db.listWalletSavedUserIds().includes(after1.id));
});
