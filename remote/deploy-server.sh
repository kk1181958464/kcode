#!/usr/bin/env bash
set -euo pipefail

PUBLIC_ORIGIN="${1:-}"
if [[ ! "$PUBLIC_ORIGIN" =~ ^https://[^/]+$ ]]; then
  echo "Usage: $0 https://remote.example.com" >&2
  exit 2
fi

cd "$(dirname "$0")"
install -d -m 0750 data
chown 10001:10001 data

DATA_KEY=""
if [[ -f .env ]]; then
  DATA_KEY="$(sed -n 's/^KCODE_DATA_KEY=//p' .env | head -n 1)"
fi
if [[ -z "$DATA_KEY" ]]; then
  DATA_KEY="$(openssl rand -base64 32)"
fi

umask 077
printf '%s\n' \
  "KCODE_HOST=0.0.0.0" \
  "KCODE_PORT=8787" \
  "KCODE_DATABASE=/data/kcode-remote.sqlite" \
  "KCODE_PUBLIC_ORIGIN=$PUBLIC_ORIGIN" \
  "KCODE_RELEASE=0.1.0" \
  "KCODE_DATA_KEY=$DATA_KEY" \
  "KCODE_ALLOW_REGISTRATION=false" \
  "KCODE_SESSION_DAYS=30" >.env

docker compose config --quiet
docker compose up -d --build --remove-orphans
