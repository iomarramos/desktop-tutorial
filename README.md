# DESENCAJADO — Web de suscripción + wallet de fidelidad

Sitio de **DESENCAJADO — Papas y Café** (Huaraz) con dos partes:

1. **Pre-registro** para la apertura (nombre, teléfono, DNI) — igual que antes.
2. **Wallet de fidelidad**: login con Google, verificación en dos pasos (2FA)
   por código QR, estrellas por consumo canjeables más adelante, código de
   referidos y cuentas familiares/compartidas, más un panel de administrador
   con tráfico de consumo, afiliados y grupos compartidos.

Todo corre en un servidor HTTP plano (sin frameworks) con persistencia en
SQLite.

## Requisitos

- Node.js 22.5 o superior (usa el módulo experimental `node:sqlite`, sin
  dependencias externas — el TOTP se implementa con `node:crypto` y el QR
  se dibuja en el navegador con [qrcodejs](https://github.com/davidshimjs/qrcodejs)
  vía CDN, así el secreto de 2FA nunca se envía a un tercero).
- Credenciales OAuth de Google si quieres probar el login (ver abajo).

## Configuración

Copia `.env.example` a `.env` (o exporta las variables) y completa:

```bash
PORT=3000
ADMIN_TOKEN=un-token-secreto
GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=tu-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
SOLES_PER_PUNTO=5
```

Para obtener las credenciales de Google: crea un proyecto en
[Google Cloud Console](https://console.cloud.google.com/apis/credentials),
crea un "OAuth 2.0 Client ID" de tipo *Web application* y agrega
`GOOGLE_REDIRECT_URI` como *Authorized redirect URI*. Sin estas variables,
`/auth/google` responde con un error explicando que falta configurar el login.

## Ejecutar en local

```bash
npm start
```

El servidor levanta en `http://localhost:3000` (o el puerto indicado por la
variable de entorno `PORT`).

## Cómo funciona

- `server.js`: servidor HTTP que sirve `public/` y expone toda la API.
- `db.js`: acceso a SQLite (`data/suscripciones.sqlite`, se crea sola y no
  se versiona en git). Tablas: `subscribers` (pre-registro), `users`,
  `sessions`, `purchases`, `points_ledger`, `family_groups`.
- `auth/google.js`: flujo OAuth2 con Google (authorization code + verificación
  del `id_token` vía el endpoint `tokeninfo` de Google).
- `auth/totp.js`: generación y verificación de códigos TOTP (RFC 6238) para
  el segundo factor, con `node:crypto` puro.
- `public/index.html`: formulario de pre-registro.
- `public/cuenta.html`: sesión del cliente — login con Google, activación de
  2FA con QR, saldo de estrellas, historial de consumo, código de referido y
  grupo familiar.
- `public/admin.html`: panel de administrador (protegido por `ADMIN_TOKEN`)
  con tráfico de consumo por hora/día, usuarios y su wallet, referidos,
  grupos compartidos, compras y la lista de pre-registro.

## Flujo de login y 2FA

1. El cliente entra a `/cuenta.html` y pulsa **Continuar con Google**.
2. Tras el consentimiento de Google, si es su primer login se le pide
   **configurar 2FA**: se muestra un QR (secreto TOTP) para escanear con
   Google Authenticator/Authy y debe confirmar un código de 6 dígitos.
3. En logins posteriores, tras el login de Google se le pide **el código de
   6 dígitos** de su app (segundo factor obligatorio).
4. Solo entonces la sesión queda `active` y puede ver su wallet.

Las sesiones se guardan como tokens opacos en la tabla `sessions` (cookie
`sid`, `HttpOnly`, `SameSite=Lax`, `Secure` cuando la conexión es HTTPS).

## API — suscripción pre-apertura

- `POST /api/subscribe` — Body `{ nombre, telefono, dni, unasam }`.
- `GET /api/subscribe/count` — Total de registrados.
- `GET /api/admin/subscribers` — Lista completa (header `x-admin-token`).

## API — cuenta / wallet (requiere sesión, cookie `sid`)

- `GET /auth/google` — Inicia el login (acepta `?ref=CODIGO` para asociar un
  referido).
- `GET /auth/google/callback` — Callback OAuth.
- `POST /api/logout`
- `GET /api/me` — Estado de la sesión (`authenticated`, `stage`, perfil).
- `POST /api/2fa/setup` — Genera el secreto TOTP y la URL `otpauth://` para
  el QR (solo en primer login).
- `POST /api/2fa/verify` — Body `{ code }`. Confirma el 2FA (setup o login).
- `GET /api/purchases?page=&limit=` — Historial de consumo propio, paginado.
- `POST /api/points/redeem` — Body `{ puntos, motivo }`. Canjea estrellas.
- `POST /api/family/create` — Body `{ name }`. Crea grupo familiar/compartido.
- `POST /api/family/join` — Body `{ inviteCode }`. Se une a un grupo.

## API — administrador (header `x-admin-token`)

- `POST /api/admin/purchases` — Body `{ email, monto, producto }`. Registra
  una compra/consumo del cliente (por su email de Google) y le suma
  estrellas (`monto / SOLES_PER_PUNTO`, redondeado hacia abajo).
- `GET /api/admin/purchases?page=&limit=` — Todas las compras, paginado.
- `GET /api/admin/users?page=&limit=` — Usuarios con su saldo de estrellas,
  gasto total y estado de 2FA, paginado.
- `GET /api/admin/referrals?page=&limit=` — Usuarios afiliados/referidos y
  quién los refirió, paginado.
- `GET /api/admin/family-groups?page=&limit=` — Grupos familiares/compartidos
  con sus miembros, paginado.
- `GET /api/admin/stats/traffic` — Conteo de compras por hora del día (0-23)
  y por día de la semana, para ver horarios/tráfico pico.

```bash
ADMIN_TOKEN=un-token-secreto npm start
curl -H "x-admin-token: un-token-secreto" \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"cliente@gmail.com","monto":25,"producto":"Frappé"}' \
  http://localhost:3000/api/admin/purchases
```
