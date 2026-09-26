# Solvent runtime: proxy + hourly treasury cycle + publishing.
# The treasury key comes from the environment (.env), never from the image.
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install --no-save tsx
COPY tsconfig.json ./
COPY src ./src
ENV SOLVENT_PROXY_HOST=0.0.0.0 SOLVENT_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8787
CMD ["npx", "tsx", "src/server.ts"]
