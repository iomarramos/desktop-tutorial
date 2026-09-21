FROM node:22-slim

WORKDIR /app

# Instala dependencias primero para aprovechar la cache de capas de Docker
# cuando solo cambia el código y no package*.json.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .

# data/ es donde vive la base SQLite — se monta como volumen para que
# sobreviva a recrear el contenedor (ver docker-compose.yml).
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

VOLUME ["/app/data"]

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
