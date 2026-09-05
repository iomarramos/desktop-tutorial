# DESENCAJADO — Web de suscripción + wallet de fidelidad

Sitio de **DESENCAJADO — Papas y Café** (Huaraz) con dos partes:

1. **Pre-registro** para la apertura (nombre, teléfono, DNI) — igual que antes.
2. **Wallet de fidelidad**: login con Google, verificación en dos pasos (2FA)
   por código QR (con bloqueo tras varios intentos fallidos), estrellas por
   consumo canjeables más adelante (con barra de progreso hacia la próxima
   recompensa), código de referidos **con bono de puntos** para quien refiere
   y para el referido, cuentas familiares/compartidas (crear, unirse, salir,
   expulsar miembros), tarjeta real de **Google Wallet**, notificaciones
   **push** de promociones, y cierre de sesión en todos los dispositivos.
3. **Panel de administrador**: tráfico de consumo por horario, usuarios y su
   wallet (con buscador y exportación a CSV, y botón para forzar el cierre
   de sesión de un cliente), afiliados, grupos compartidos, registro de
   compras desde un formulario, **catálogo de productos** (crear/editar/
   desactivar/eliminar) y **promociones completas** (foto, vigencia,
   productos asociados, código de publicación autogenerado, códigos de
   canje por sucursal/tanda con límite de usos, editar/desactivar/eliminar)
   con banner + popup + push.

Todo corre en un servidor HTTP plano (sin frameworks) con persistencia en
SQLite, con tests automatizados (`node:test`, sin dependencias), CI en
GitHub Actions, y listo para correr en Docker.

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
  `sessions`, `purchases`, `points_ledger`, `family_groups`, `products`,
  `promotions`, `promotion_products`, `promotion_codes`,
  `promotion_redemptions`, `push_subscriptions`.
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
  promociones (con foto, vigencia y productos), un campo para **canjear un
  código de promoción**, activar notificaciones push y agregar a Google Wallet.
- `public/admin.html`: panel de administrador (protegido por `ADMIN_TOKEN`)
  con tráfico de consumo por hora/día, usuarios y su wallet (con buscador y
  exportación CSV), referidos, grupos compartidos, compras (+ formulario
  para registrar una nueva), **catálogo de productos** (nombre, foto, precio),
  **promociones** (título, mensaje, foto, vigencia, productos asociados,
  código de publicación autogenerado, códigos de canje con etiqueta/límite
  de usos, envío push) y la lista de pre-registro.
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

## Modelo de promociones

Cada **promoción** tiene:

- Título, mensaje y una foto (URL — no hay subida de archivos, se pega el
  link de una imagen ya alojada en algún lado, igual que la foto de perfil
  de Google).
- **Vigencia**: `starts_at` / `ends_at` opcionales; fuera de ese rango, o con
  `active = 0`, deja de aparecer en `/api/promotions` y en el banner del
  cliente.
- **Productos o conjuntos de productos**: se asocian desde un catálogo
  (`products`, gestionado en la pestaña *Productos* del admin) vía la tabla
  `promotion_products`.
- **Código de publicación** (`publication_code`, ej. `PROMO-0007`): un
  identificador interno autogenerado para administrar/editar la promoción,
  **no** es lo que canjea el cliente.
- **Códigos de canje** (`promotion_codes`): uno o varios códigos que el
  cliente sí canjea, cada uno con su propia etiqueta (ej. "Sucursal Centro",
  "Tanda 1") y límite de usos opcional. Se agregan desde el admin dentro de
  cada promoción. El cliente los canjea desde `/cuenta.html` con
  `POST /api/promotions/redeem`, que valida vigencia y límite de usos y
  registra el canje en `promotion_redemptions`. El endpoint público
  `GET /api/promotions` **no** expone estos códigos (evita que cualquier
  usuario con sesión vea los códigos pensados para otro canal/sucursal);
  el cliente necesita conseguir el código por donde se distribuya (flyer,
  redes, etc.).

La promoción vigente más reciente se muestra como **popup** apenas se carga
`/` (landing pública, sin login) o `/cuenta.html`. El popup se cierra y no
vuelve a aparecer una vez visto (se recuerda por `publication_code` en
`localStorage` del navegador); una promoción nueva sí se muestra de nuevo.

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
- `POST /api/family/leave` — Sale del grupo. Si el que sale es el dueño, el
  grupo se disuelve para todos (no hay a quién transferirlo).
- `POST /api/family/remove-member` — Body `{ userId }`. Solo el dueño puede
  expulsar a otro miembro.
- `POST /api/logout-all` — Cierra la sesión actual y todas las demás abiertas
  del usuario (otros dispositivos/navegadores).
- `GET /api/promotions` — Promociones activas y vigentes (público, no
  requiere sesión — se usa tanto en `/` como en `/cuenta.html` para mostrar
  el popup/banner). No incluye los códigos de canje.
- `POST /api/promotions/redeem` — Body `{ code }`. Canjea un código de
  promoción (requiere sesión activa); valida vigencia y límite de usos.
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
  (activas e inactivas), con sus productos y códigos de canje.
- `POST /api/admin/promotions` — Body
  `{ title, body, photoUrl, startsAt, endsAt, productIds }`. Publica una
  promoción (aparece como popup/banner en `/` y `/cuenta.html`) y la envía
  por push a todos los dispositivos suscritos si `VAPID_*` está configurado.
  Genera automáticamente el `publication_code`.
- `POST /api/admin/promotions/deactivate` — Body `{ id }`. Deja de mostrarla.
- `POST /api/admin/promotions/update` — Body
  `{ id, title, body, photoUrl, startsAt, endsAt, productIds }` (todos
  opcionales salvo `id`). Edita una promoción existente.
- `POST /api/admin/promotions/delete` — Body `{ id }`. Borrado real; falla
  con un mensaje claro si la promoción ya tiene canjes registrados (en ese
  caso hay que desactivarla en vez de borrarla, para no perder el historial).
- `POST /api/admin/promotions/codes` — Body
  `{ promotionId, code, label, maxUses }`. Agrega un código de canje a la
  promoción (si `code` viene vacío, se genera uno al azar).
- `GET /api/admin/products?page=&limit=` — Catálogo paginado.
- `GET /api/admin/products/active` — Catálogo activo sin paginar (para el
  selector de productos al crear una promoción).
- `POST /api/admin/products` — Body `{ name, photoUrl, price }`.
- `POST /api/admin/products/deactivate` — Body `{ id }`.
- `POST /api/admin/products/update` — Body `{ id, name, photoUrl, price }`.
- `POST /api/admin/products/delete` — Body `{ id }`. Borrado real; falla si
  el producto está asociado a alguna promoción (desactivarlo en ese caso).
- `POST /api/admin/users/force-logout` — Body `{ email }`. Cierra la sesión
  de ese cliente en todos sus dispositivos (celular perdido/robado, cuenta
  comprometida, etc.).
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

## Referidos

Cuando alguien se registra usando el enlace de referido de otro cliente
(`?ref=CODIGO`), al vincularse la cuenta se pagan dos bonos de una sola vez
(no se repiten si el mismo referido se "re-vincula"):

- `REFERRAL_BONUS_POINTS` (default 20) para quien refirió.
- `REFERRAL_WELCOME_POINTS` (default 10) para el que se registró.

Poner cualquiera de las dos en `0` la desactiva.

## Seguridad

- **Bloqueo de intentos de 2FA**: tras `TOTP_MAX_ATTEMPTS` códigos
  incorrectos seguidos (default 5) la sesión queda bloqueada
  `TOTP_LOCKOUT_MINUTES` minutos (default 5) antes de poder reintentar. El
  contador se guarda por sesión en la tabla `sessions` y se resetea al
  acertar.
- **Rate limiting** en memoria (por IP) sobre los endpoints más sensibles a
  abuso: `/api/subscribe` (10/hora), `/api/2fa/verify`, `/api/points/redeem`
  y `/api/promotions/redeem` (20 cada 5 min). Es de un solo proceso —
  suficiente para esta app, que ya corre con SQLite de un solo proceso; con
  varias réplicas cada una lleva su propio conteo.
- **Revocación de sesiones**: el cliente puede cerrar sesión en todos sus
  dispositivos desde `/cuenta.html`, y el admin puede forzarlo desde
  `/admin.html` (ej. celular perdido/robado, sospecha de cuenta comprometida).
- Las cookies de sesión son `HttpOnly`, `SameSite=Lax`, y `Secure` cuando la
  conexión llega por HTTPS.
- El endpoint público `GET /api/promotions` nunca expone los códigos de
  canje de una promoción (ver "Modelo de promociones" arriba).

## Tests

Sin dependencias externas — usa el test runner nativo de Node
(`node:test` + `node:assert`). Cada archivo de test usa su propia base de
datos temporal (vía la variable `DB_FILE`, que sobreescribe la ruta por
defecto de `data/suscripciones.sqlite`) para no tocar datos de desarrollo.

```bash
npm test
```

Cubre: TOTP (generar/verificar/tolerancia de reloj), rate limiting,
referidos (bono único), grupo familiar (crear/unirse/expulsar/salir),
productos y promociones (crear/editar/borrado bloqueado si están en uso),
canje de código (vigencia, límite de usos), compras y progreso de
recompensa, y bloqueo/reseteo de intentos de 2FA.

## CI

`.github/workflows/ci.yml` corre en cada push/PR: verifica sintaxis de
todos los `.js` del proyecto, corre `npm test`, y levanta el servidor real
para un smoke test (`GET /`, `/cuenta.html`, `/admin.html` y
`/api/subscribe/count`).

## Docker

```bash
cp .env.example .env   # completar con tus valores
docker compose up --build
```

Esto construye la imagen (`node:22-slim`), instala solo dependencias de
producción, y monta un volumen (`desencajado_data`) para `data/` — la base
SQLite sobrevive a recrear el contenedor. El puerto por defecto es `3000`
(cambiar el mapeo en `docker-compose.yml` para usar otro puerto de host).

**Backup de la base de datos**: `scripts/backup.js` usa `VACUUM INTO` de
SQLite para sacar una copia consistente sin parar el servidor (evita el
riesgo de copiar el archivo `.sqlite` a mano mientras hay una escritura en
curso):

```bash
# En local
npm run backup                       # guarda en data/backups/

# Contra el contenedor (ejecuta el script dentro, ya tiene acceso al volumen)
docker compose exec app node scripts/backup.js
```

No hay backups automáticos/programados — conviene agregar un cron (en el
host, o un contenedor aparte) que corra ese comando periódicamente y suba
el resultado a almacenamiento externo (S3, etc.) si esto va a producción real.
