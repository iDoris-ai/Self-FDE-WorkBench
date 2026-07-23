#!/usr/bin/env bash
# CC-58: read values from loop-engineer/.env and set them as CF Worker secrets
# (workbench-loop-engineer). Values are never printed. Run inside deploy/loop-engineer:
#   bash set-secrets.sh
set -eo pipefail

ENV_FILE="$(cd "$(dirname "$0")/../../loop-engineer" && pwd)/.env"
if [ ! -f "$ENV_FILE" ]; then echo "env not found: $ENV_FILE"; exit 1; fi

set -a; . "$ENV_FILE"; set +a

put() {
  key="$1"
  value="$2"
  if [ -z "$value" ]; then
    echo "  skip $key (empty in .env)"
    return 0
  fi
  if printf '%s' "$value" | pnpm exec wrangler secret put "$key" >/dev/null 2>&1; then
    echo "  ok   $key"
  else
    echo "  FAIL $key"
  fi
}

echo "setting secrets for workbench-loop-engineer ..."
put WORKBENCH_TOKEN            "${WORKBENCH_TOKEN:-}"
put WORKBENCH_ALLOWED_ORIGINS  "${WORKBENCH_ALLOWED_ORIGINS:-}"
put HILINKUP_API_KEY           "${HILINKUP_API_KEY:-}"
put HILINKUP_BASE_URL          "${HILINKUP_BASE_URL:-}"
put DEEPSEEK_API_KEY           "${DEEPSEEK_API_KEY:-}"
put DEEPSEEK_BASE_URL          "${DEEPSEEK_BASE_URL:-}"
put DEEPSEEK_MODEL             "${DEEPSEEK_MODEL:-}"
put WORKBENCH_CALLBACK_URL     "${WORKBENCH_CALLBACK_URL:-}"
put WORKBENCH_CALLBACK_SECRET  "${WORKBENCH_CALLBACK_SECRET:-}"
put WORKBENCH_PUSH_TOKEN       "${WORKBENCH_PUSH_TOKEN:-${LOOP_GIT_PUSH_TOKEN:-}}"
put CLOUDFLARE_ACCOUNT_ID      "${CLOUDFLARE_ACCOUNT_ID:-7bf23342f21baa5ebfc7bc7b74f5a1f2}"
put CLOUDFLARE_API_TOKEN       "${CLOUDFLARE_API_TOKEN:-}"
echo "done. next: pnpm exec wrangler deploy"
