# Flujo de cliente nuevo y puerta de producción

## Flujo esperado

1. **Google** — el cliente entiende el beneficio antes de autenticarse y ve qué datos entrega Google.
2. **Datos mínimos** — DNI para no duplicar la wallet y celular para identificar compras en el local. Las campañas requieren un permiso separado.
3. **Seguridad** — QR TOTP, clave manual visible y código de confirmación.
4. **Primer valor** — saldo, progreso y beneficios aparecen antes de pedir permisos opcionales.
5. **Activación opcional** — Push y Google Wallet se ofrecen desde la wallet; si no están configurados, no bloquean puntos ni compras.

El modo aislado reproduce los pasos 2–5 sin llamar a Google ni crear clientes reales:

```bash
npm run test:onboarding
```

`POST /api/test/session` solo existe cuando `TEST_MODE_ENABLED=true`, `NODE_ENV` no es `production` y el encabezado `x-test-token` coincide con un token de al menos 16 caracteres.

## Comprobaciones mínimas antes de integrar

### Docker real

- CI debe construir la imagen y arrancar un contenedor real.
- `/api/health` debe responder `200` y `status: ready`.
- El proceso debe ejecutarse como usuario `node`, no `root`.
- Crear datos, recrear el contenedor y confirmar que el volumen conserva SQLite.
- Ejecutar `npm run backup` dentro del contenedor y restaurar esa copia en un entorno temporal.
- Reiniciar el contenedor durante una escritura y confirmar que SQLite/WAL vuelve sin corrupción.

### Google OAuth

- Pantalla de consentimiento publicada y dominio `desencajado.pe` verificado.
- Redirect URI exacta: `https://desencajado.pe/auth/google/callback`.
- Probar cuenta nueva, cuenta existente, cancelación en Google, `state` vencido y cierre de sesión.
- Confirmar que se rechazan correo no verificado, audiencia incorrecta y token vencido.
- Confirmar cookies `Secure`, `HttpOnly` y `SameSite=Lax` detrás del proxy HTTPS real.

### Web Push

- Probar en Chrome Android y escritorio bajo HTTPS; en iOS validar como app instalada en pantalla de inicio.
- Probar permiso aceptado, rechazado y revocado.
- Enviar una promoción real de prueba y confirmar título, cuerpo, icono y apertura de `/cuenta.html`.
- Confirmar que respuestas 404/410 eliminan suscripciones vencidas.
- Rotar VAPID solo con un plan: cambiar claves invalida suscripciones existentes.

### Google Wallet

- Cuenta Issuer aprobada y service account autorizada en el issuer correcto.
- Ejecutar `npm run preflight:production -- --strict-integrations` con secretos reales en el entorno, nunca en Git.
- Guardar un pase en un Android real y confirmar nombre, QR y saldo inicial.
- Registrar una compra y verificar que el saldo se actualiza.
- Publicar una promoción de prueba y verificar mensaje e imagen del pase.
- Confirmar comportamiento cuando el usuario abre el enlace pero no guarda el pase; `wallet_saved_at` es una señal aproximada, no confirmación de Google.

## Decisión de integración

No conviene integrar el PR #2 como una sola unidad mientras falte cualquiera de estas cuatro pruebas reales. El cambio supera 8.000 líneas y mezcla identidad, dinero/puntos, administración y operación.

División mínima recomendada:

1. **Base y Docker:** esquema SQLite, salud, backup, CI y contenedor.
2. **Identidad:** Google OAuth, perfil, sesiones y 2FA.
3. **Fidelidad:** compras, puntos, referidos, familia y promociones sin canales externos.
4. **Canales externos:** Web Push y Google Wallet, activados por configuración.

Cada bloque debe poder desplegarse con su propia migración, prueba de reversión y bandera de activación. Esta rama sirve como referencia integrada; no convierte por sí sola las credenciales externas en verificadas.
