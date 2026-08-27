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

# Fonts.
#
# This image previously shipped NO fonts at all, so Chromium drew a "missing
# glyph" box for every character the bundled caption webfonts do not cover.
# Inter, Montserrat, Anton, Bebas Neue, Archivo Black, Luckiest Guy, Permanent
# Marker, Playfair Display and Space Mono are Latin-only; Poppins adds
# Devanagari and nothing else. So a Hindi, Bengali, Arabic, Tamil, Thai or
# Chinese caption exported as a row of tofu boxes. macOS previews looked fine
# because the OS quietly supplied its own Indic fonts — the container has
# nothing to fall back on, which is why the bug only showed in the export.
#
# fonts-noto-core carries the per-script Noto Sans/Serif families (Devanagari,
# Bengali, Arabic, Tamil, Telugu, Gujarati, Gurmukhi, Kannada, Malayalam,
# Oriya, Sinhala, Thai, Hebrew, Greek, Cyrillic …), so the family names the
# caption stacks list resolve to real files. CJK and emoji ship separately.
#
# Kept as its own layer: it adds ~300MB and changes far less often than the
# Chromium library list above, so the two should not share a cache entry. Drop
# fonts-noto-cjk to save most of that size if Chinese/Japanese/Korean captions
# are out of scope — tofu returns for those three and nothing else.
RUN apt-get update && apt-get install -y \
    fonts-noto-core \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f

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
