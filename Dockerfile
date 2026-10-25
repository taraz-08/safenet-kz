FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY extension ./extension
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 SAFENET_HOSTED=1
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/public/safenet-extension.zip ./public/safenet-extension.zip
COPY public/demo-feed.html ./public/demo-feed.html
COPY server ./server
COPY extension/content.js ./extension/content.js
COPY data/model.json data/metrics.json ./data/
COPY data/stream/corpus.json ./data/stream/corpus.json
COPY docs/pitch.html ./docs/pitch.html
CMD ["node", "server/index.mjs"]
