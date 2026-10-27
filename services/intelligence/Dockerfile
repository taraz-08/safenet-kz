FROM node:22-bookworm-slim AS media-ocr
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY scripts/setup-ocr.mjs ./scripts/setup-ocr.mjs
RUN node scripts/setup-ocr.mjs && npm prune --omit=dev --ignore-scripts

FROM python:3.11-slim-bookworm
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY services/intelligence/requirements.lock.txt ./requirements.lock.txt
RUN pip install -r requirements.lock.txt && python -m playwright install --with-deps chromium
COPY services/intelligence/safenet ./safenet
COPY --from=media-ocr /usr/local/bin/node /usr/local/bin/node
COPY --from=media-ocr /build/node_modules ./node_modules
COPY --from=media-ocr /build/public/ocr ./public/ocr
COPY package.json ./package.json
COPY services/intelligence/media-ocr.mjs ./services/intelligence/media-ocr.mjs
RUN useradd --create-home appuser && mkdir -p /app/runtime/media /app/data/models && chown -R appuser:appuser /app /ms-playwright
USER appuser
EXPOSE 8100
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8100/api/v1/health', timeout=4)"
CMD ["uvicorn", "safenet.app:app", "--host", "0.0.0.0", "--port", "8100"]
