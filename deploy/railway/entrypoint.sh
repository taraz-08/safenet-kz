#!/bin/sh
set -eu

# Never change ownership of /data itself or the existing legacy files.
if [ -L /data/ai ]; then
  echo 'Refusing a symlink at /data/ai' >&2
  exit 1
fi
if [ "$(id -u)" = 0 ]; then
  install -d -m 750 -o safenet -g safenet /data/ai
  chown -R safenet:safenet /data/ai
fi
export SAFENET_DATABASE_URL=sqlite:////data/ai/safenet.db
export SAFENET_DATABASE_HOST=
export SAFENET_LOCAL_ADMIN=false SAFENET_SECURE_COOKIE=true
export SAFENET_QUEUE=local SAFENET_SCHEDULER_ENABLED=true
# The 100 MB cloud volume stores text findings only; media analysis is local-only.
export SAFENET_MEDIA_ENABLED=false SAFENET_VISION_URL= SAFENET_VISION_MODEL= SAFENET_START_OLLAMA=false
export SAFENET_RETENTION_DAYS=7
export SAFENET_ALLOWED_ORIGINS="${SAFENET_ALLOWED_ORIGINS:-https://${RAILWAY_PUBLIC_DOMAIN:-safenet-kz.up.railway.app}}"
: "${SAFENET_ADMIN_CODE:?SAFENET_ADMIN_CODE must be configured in Railway}"
export PORT="${PORT:-3000}" HOSTNAME=0.0.0.0
cd /app/services/intelligence
if [ "$(id -u)" = 0 ]; then
  exec gosu safenet:safenet python /app/deploy/railway/serve.py
fi
exec python /app/deploy/railway/serve.py
