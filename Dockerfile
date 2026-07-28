FROM node:22-bookworm-slim

WORKDIR /app

# Chromium shared libraries (derived from ldd on the Chromium binary — any
# missing one crashes at render time).
RUN apt-get update && apt-get install -y \
    libnss3 \
    libdbus-1-3 \
    libatk1.0-0 \
    libgbm-dev \
    libasound2 \
    libxrandr2 \
    libxkbcommon-dev \
    libxfixes3 \
    libxcomposite1 \
    libxdamage1 \
    libatk-bridge2.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    libcups2 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./package.json

RUN npm install --legacy-peer-deps

# Pre-download Chromium at build time so boot is instant.
RUN npx remotion browser ensure

COPY src ./src
COPY tsconfig.json ./tsconfig.json
COPY remotion.config.ts ./remotion.config.ts

# Bundle the Remotion project ONCE at build time — renders reuse it from disk.
RUN npx remotion bundle

ENV RENDER_TMP_DIR=/render-tmp

CMD ["node", "--experimental-strip-types", "--no-warnings", "src/vps-server.ts"]

EXPOSE 8080
