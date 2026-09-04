const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { addSubscriber, dniExists, getCount, listSubscribers } = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
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

function serveStatic(req, res) {
  const requestPath = decodeURIComponent(req.url.split('?')[0]);
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

const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'POST' && url === '/api/subscribe') {
    return handleSubscribe(req, res);
  }
  if (req.method === 'GET' && url === '/api/subscribe/count') {
    return handleCount(req, res);
  }
  if (req.method === 'GET' && url === '/api/admin/subscribers') {
    return handleAdminList(req, res);
  }
  if (req.method === 'GET') {
    return serveStatic(req, res);
  }

  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Método no permitido');
});

server.listen(PORT, () => {
  console.log(`DESENCAJADO suscripción escuchando en http://localhost:${PORT}`);
});
