const path = require('node:path');
const fs = require('node:fs');
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

module.exports = { addSubscriber, dniExists, getCount, listSubscribers };
