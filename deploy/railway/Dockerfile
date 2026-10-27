# Build from the repository root: docker build -f deploy/railway/Dockerfile .
# Cloud deployment is TEXT ONLY. Photo/video/audio inference remains local.
FROM node:22-bookworm-slim AS ocr
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY scripts/setup-ocr.mjs ./scripts/setup-ocr.mjs
RUN node scripts/setup-ocr.mjs && npm prune --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS console
WORKDIR /build/console
COPY apps/console/package.json apps/console/package-lock.json ./
RUN npm ci
COPY apps/console/src ./src
COPY apps/console/public ./public
COPY apps/console/next.config.ts apps/console/tsconfig.json apps/console/postcss.config.mjs ./
# Rewrites are generated at build time. This API address is in the same container.
# /events is not exposed by Next; the existing UI uses its explicit API polling fallback.
ENV SAFENET_API_URL=http://127.0.0.1:8100 NEXT_PUBLIC_WS_URL=disabled: NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM python:3.11-slim-bookworm AS runtime
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PIP_NO_CACHE_DIR=1 \
    NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PYTHONPATH=/app/services/intelligence SAFENET_API_URL=http://127.0.0.1:8100 \
    SAFENET_WHISPER_MODEL=/app/data/models/faster-whisper-small \
    SAFENET_VISION_URL="" SAFENET_VISION_MODEL="" SAFENET_START_OLLAMA=false \
    SAFENET_LOCAL_ADMIN=false SAFENET_SECURE_COOKIE=true SAFENET_QUEUE=local \
    SAFENET_SCHEDULER_ENABLED=true SAFENET_DATABASE_URL=sqlite:////data/ai/safenet.db \
    SAFENET_MEDIA_ROOT=/data/ai/media SAFENET_MEDIA_ENABLED=false SAFENET_RETENTION_DAYS=7 \
    HF_HUB_OFFLINE=1 OMP_NUM_THREADS=1
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends gosu ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/*
# This lock contains no Windows-only pywin32/winloop packages; do not silently unpin it.
COPY services/intelligence/requirements.lock.txt /tmp/requirements.lock.txt
RUN pip install -r /tmp/requirements.lock.txt \
    && python -m playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*
# Verified from https://huggingface.co/api/models/Systran/faster-whisper-small
# Optional image preparation only; it does not enable media in the cloud entrypoint.
ARG WITH_MEDIA=false
ARG WHISPER_REVISION=536b0662742c02347bc0e980a01041f333bce120
RUN if [ "$WITH_MEDIA" = "true" ]; then \
      HF_HUB_OFFLINE=0 HF_HUB_DISABLE_XET=1 python -c "from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-small', revision='$WHISPER_REVISION', local_dir='/app/data/models/faster-whisper-small', allow_patterns=['config.json','model.bin','tokenizer.json','vocabulary.txt'])"; \
    elif [ "$WITH_MEDIA" != "false" ]; then echo 'WITH_MEDIA must be true or false' >&2; exit 1; fi
COPY --from=ocr /usr/local/bin/node /usr/local/bin/node
COPY --from=ocr /app/node_modules /app/node_modules
COPY --from=ocr /app/public/ocr /app/public/ocr
COPY package.json /app/package.json
COPY --from=console /build/console/.next/standalone /app/apps/console
COPY --from=console /build/console/.next/static /app/apps/console/.next/static
COPY --from=console /build/console/public /app/apps/console/public
COPY services/intelligence/safenet /app/services/intelligence/safenet
COPY services/intelligence/media-ocr.mjs /app/services/intelligence/media-ocr.mjs
COPY deploy/railway /app/deploy/railway
RUN groupadd --gid 10001 safenet && useradd --uid 10001 --gid safenet --create-home safenet \
    && sed -i 's/\r$//' /app/deploy/railway/entrypoint.sh \
    && chmod 755 /app/deploy/railway/entrypoint.sh \
    && mkdir -p /app/services/intelligence/runtime \
    && chown -R safenet:safenet /app /ms-playwright
# Root is only used to initialize the mounted directory; entrypoint drops privileges.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=8s --start-period=90s CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:'+os.getenv('PORT','3000')+'/api/v1/health',timeout=6)"
ENTRYPOINT ["/app/deploy/railway/entrypoint.sh"]
