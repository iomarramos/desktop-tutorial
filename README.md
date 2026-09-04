# DESENCAJADO — Web de suscripción

Página de pre-registro para la apertura de **DESENCAJADO — Papas y Café** (Huaraz),
con formulario de suscripción (nombre, teléfono y DNI) y persistencia en una
base de datos SQLite.

## Requisitos

- Node.js 22.5 o superior (usa el módulo experimental `node:sqlite`, sin
  dependencias externas).

## Ejecutar en local

```bash
npm start
```

El servidor levanta en `http://localhost:3000` (o el puerto indicado por la
variable de entorno `PORT`).

## Cómo funciona

- `server.js`: servidor HTTP (sin frameworks) que sirve el sitio estático de
  `public/` y expone la API de suscripción.
- `db.js`: acceso a la base de datos SQLite (`data/suscripciones.sqlite`,
  se crea automáticamente al iniciar el servidor y no se versiona en git).
- `public/index.html`: formulario de suscripción con validación de nombre,
  celular peruano (9 dígitos) y DNI (8 dígitos).

## API

- `POST /api/subscribe` — Body JSON `{ nombre, telefono, dni, unasam }`.
  Valida los campos, evita DNIs duplicados y guarda el registro.
- `GET /api/subscribe/count` — Devuelve el total de personas registradas
  (usado para el contador en la página).
- `GET /api/admin/subscribers` — Lista todos los registros (nombre, teléfono,
  DNI, si es estudiante UNASAM y fecha). Protegido por token: requiere el
  header `x-admin-token` con el valor de la variable de entorno
  `ADMIN_TOKEN`. Si `ADMIN_TOKEN` no está configurada, este endpoint
  rechaza todas las solicitudes.

```bash
ADMIN_TOKEN=un-token-secreto npm start
curl -H "x-admin-token: un-token-secreto" http://localhost:3000/api/admin/subscribers
```
