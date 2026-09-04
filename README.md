# DESENCAJADO — Web de suscripción + wallet de fidelidad

Sitio de **DESENCAJADO — Papas y Café** (Huaraz) con dos partes:

1. **Pre-registro** para la apertura (nombre, teléfono, DNI) — igual que antes.
2. **Wallet de fidelidad**: login con Google, verificación en dos pasos (2FA)
   por código QR, estrellas por consumo canjeables más adelante (con barra de
   progreso hacia la próxima recompensa), código de referidos, cuentas
   familiares/compartidas, tarjeta real de **Google Wallet** y notificaciones
   **push** de promociones.
3. **Panel de administrador**: tráfico de consumo por horario, usuarios y su
   wallet (con buscador y exportación a CSV), afiliados, grupos compartidos,
   registro de compras desde un formulario, y publicación de promociones
   (banner + push).

Todo corre en un servidor HTTP plano (sin frameworks) con persistencia en
SQLite.

## Requisitos

- Node.js 22.5 o superior (usa el módulo experimental `node:sqlite`).
- El TOTP y el JWT de Google Wallet se implementan con `node:crypto` puro
  (sin dependencias). El QR de 2FA se dibuja en el navegador con
  [qrcodejs](https://github.com/davidshimjs/qrcodejs) vía CDN, así el
  secreto nunca se envía a un tercero.
- Notificaciones push usan la librería [`web-push`](https://github.com/web-push-libs/web-push)
  (única dependencia npm del proyecto) para el cifrado del protocolo Web Push
  (RFC 8291/8292) — reimplementarlo a mano es criptografía de alto riesgo.
- Credenciales OAuth de Google si quieres probar el login (ver abajo).
- Opcional: VAPID keys (push) y credenciales de Google Wallet Issuer
  (tarjeta de fidelidad) — ambas funciones se desactivan solas si no están
  configuradas, el resto de la app funciona igual.

## Configuración

Copia `.env.example` a `.env` (o exporta las variables) y completa:

```bash
PORT=3000
ADMIN_TOKEN=un-token-secreto
GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=tu-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
SOLES_PER_PUNTO=5
REWARD_THRESHOLD=50
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
GOOGLE_WALLET_ISSUER_ID=
GOOGLE_WALLET_SERVICE_ACCOUNT_EMAIL=
GOOGLE_WALLET_PRIVATE_KEY=
GOOGLE_WALLET_ORIGIN=http://localhost:3000
```

Para obtener las credenciales de Google: crea un proyecto en
[Google Cloud Console](https://console.cloud.google.com/apis/credentials),
crea un "OAuth 2.0 Client ID" de tipo *Web application* y agrega
`GOOGLE_REDIRECT_URI` como *Authorized redirect URI*. Sin estas variables,
`/auth/google` responde con un error explicando que falta configurar el login.

Para las **notificaciones push**, genera un par de claves VAPID una sola vez:

```bash
node -e "console.log(require('web-push').generateVAPIDKeys())"
```

Para el botón **Agregar a Google Wallet**, necesitas una cuenta de
[Google Wallet Issuer](https://developers.google.com/wallet/generic/getting-started)
y una service account con la Google Wallet API habilitada (el JSON de la
service account te da `client_email` y `private_key`). Ninguna de las dos
integraciones es necesaria para que el resto de la app funcione: si faltan
las variables, el botón/las notificaciones simplemente no aparecen (el
backend responde con un error claro si se llama igual al endpoint).

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
  `sessions`, `purchases`, `points_ledger`, `family_groups`, `promotions`,
  `push_subscriptions`.
- `auth/google.js`: flujo OAuth2 con Google (authorization code + verificación
  del `id_token` vía el endpoint `tokeninfo` de Google).
- `auth/totp.js`: generación y verificación de códigos TOTP (RFC 6238) para
  el segundo factor, con `node:crypto` puro.
- `auth/push.js`: envío de notificaciones Web Push (usa `web-push` para el
  cifrado VAPID/aes128gcm).
- `auth/googleWallet.js`: construye y firma (RS256) el JWT "Save to Google
  Wallet" con la tarjeta de fidelidad del cliente.
- `public/index.html`: formulario de pre-registro.
- `public/cuenta.html`: sesión del cliente — login con Google, activación de
  2FA con QR, saldo de estrellas con barra de progreso, canje de puntos,
  historial de consumo, código de referido, grupo familiar, banner de
  promociones, activar notificaciones push y agregar a Google Wallet.
- `public/admin.html`: panel de administrador (protegido por `ADMIN_TOKEN`)
  con tráfico de consumo por hora/día, usuarios y su wallet (con buscador y
  exportación CSV), referidos, grupos compartidos, compras (+ formulario
  para registrar una nueva), promociones (crear/desactivar, con envío push)
  y la lista de pre-registro.
- `public/sw.js`: service worker que muestra las notificaciones push.

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
- `GET /api/promotions` — Promociones activas (para el banner de la cuenta).
- `GET /api/wallet/google-pass` — Devuelve `{ saveUrl }` para el botón
  "Agregar a Google Wallet" (501 si no está configurado).
- `GET /api/push/vapid-public-key` — Clave pública VAPID (no requiere sesión).
- `POST /api/push/subscribe` — Body: objeto `PushSubscription` del navegador.
- `POST /api/push/unsubscribe` — Body `{ endpoint }`.

## API — administrador (header `x-admin-token`)

- `POST /api/admin/purchases` — Body `{ email, monto, producto }`. Registra
  una compra/consumo del cliente (por su email de Google) y le suma
  estrellas (`monto / SOLES_PER_PUNTO`, redondeado hacia abajo).
- `GET /api/admin/purchases?page=&limit=&q=` — Todas las compras, paginado y
  filtrable por cliente/producto.
- `GET /api/admin/users?page=&limit=&q=` — Usuarios con su saldo de estrellas,
  gasto total y estado de 2FA, paginado y filtrable por nombre/email.
- `GET /api/admin/referrals?page=&limit=&q=` — Usuarios afiliados/referidos y
  quién los refirió, paginado y filtrable.
- `GET /api/admin/family-groups?page=&limit=` — Grupos familiares/compartidos
  con sus miembros, paginado.
- `GET /api/admin/stats/traffic` — Conteo de compras por hora del día (0-23)
  y por día de la semana, para ver horarios/tráfico pico.
- `GET /api/admin/promotions?page=&limit=` — Promociones publicadas
  (activas e inactivas).
- `POST /api/admin/promotions` — Body `{ title, body }`. Publica una
  promoción (aparece como banner en `/cuenta.html`) y la envía por push a
  todos los dispositivos suscritos si `VAPID_*` está configurado.
- `POST /api/admin/promotions/deactivate` — Body `{ id }`. Deja de mostrarla.
- `GET /api/admin/export/users.csv` — Exporta todos los usuarios a CSV.
- `GET /api/admin/export/purchases.csv` — Exporta todas las compras a CSV.
- `GET /api/admin/export/referrals.csv` — Exporta todos los referidos a CSV.

```bash
ADMIN_TOKEN=un-token-secreto npm start
curl -H "x-admin-token: un-token-secreto" \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"cliente@gmail.com","monto":25,"producto":"Frappé"}' \
  http://localhost:3000/api/admin/purchases
```
