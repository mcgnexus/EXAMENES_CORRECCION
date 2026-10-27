# syntax=docker/dockerfile:1
# Imagen de producción: app completa (API Fastify + SPA Vite) en un solo contenedor.
FROM node:24-bookworm-slim

# pdftoppm (poppler) para convertir PDFs de exámenes a PNG + fuentes (acentos, ñ).
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils fonts-dejavu-core fontconfig \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/app/data

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Compila la SPA (dist/client) y verifica que los módulos nativos (sharp/esbuild)
# funcionan en linux-x64 antes de poder desplegar una imagen rota.
RUN npm run build \
  && node -e "require('sharp'); require('esbuild'); console.log('nativas OK')"

RUN mkdir -p /app/data

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tsx se ejecuta desde node_modules (se conservan los devDependencies a propósito).
CMD ["npm", "start"]
