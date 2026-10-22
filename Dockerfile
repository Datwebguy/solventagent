# Solvent runtime: proxy + hourly treasury cycle + publishing.
# The treasury key comes from the environment (.env), never from the image.
FROM node:24.22.1-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save tsx
COPY tsconfig.json ./
COPY src ./src
ENV SOLVENT_PROXY_HOST=0.0.0.0 SOLVENT_DATA_DIR=/data
EXPOSE 8787
CMD ["npx", "tsx", "src/server.ts"]
