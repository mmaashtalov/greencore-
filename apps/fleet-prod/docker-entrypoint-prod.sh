#!/bin/sh
set -eu

: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_PUBLISHABLE_KEY:?SUPABASE_PUBLISHABLE_KEY is required}"

case "$SUPABASE_URL" in
  https://*.supabase.co) ;;
  *) echo "SUPABASE_URL must be an https://*.supabase.co endpoint" >&2; exit 64 ;;
esac
case "$SUPABASE_PUBLISHABLE_KEY" in
  sb_publishable_*) ;;
  *) echo "SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable key" >&2; exit 64 ;;
esac
case "$SUPABASE_URL" in
  *tikjmiyrhkcjrxjylmqb*) echo "Refusing to start production against fleet-mvp/demo Supabase" >&2; exit 65 ;;
esac

export SUPABASE_URL SUPABASE_PUBLISHABLE_KEY
envsubst '${SUPABASE_URL} ${SUPABASE_PUBLISHABLE_KEY}' \
  < /usr/share/nginx/html/runtime-config.template.js \
  > /usr/share/nginx/html/runtime-config.js
chmod 0444 /usr/share/nginx/html/runtime-config.js
