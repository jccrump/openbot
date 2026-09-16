#!/usr/bin/env bash
# Drive the bot's computer with Codex using any model.
#
# ChatGPT subscription (default):
#   scripts/codex-openbot.sh "open example.com and screenshot it"
#
# Any OpenAI-compatible model (DeepSeek, OpenRouter, local, ...):
#   OPENBOT_UPSTREAM_BASE_URL=https://api.deepseek.com/v1 \
#   OPENBOT_UPSTREAM_API_KEY=$DEEPSEEK_API_KEY \
#   OPENBOT_UPSTREAM_MODEL=deepseek-v4-flash \
#   scripts/codex-openbot.sh "check the OS on your computer"
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_BIN="$REPO_DIR/packages/mcp/node_modules/.bin/tsx"
MCP_SCRIPT="$REPO_DIR/packages/mcp/src/bin.ts"
BOT_ID="${OPENBOT_BOT_ID:-codex}"
SANDBOX_URL="${OPENBOT_SANDBOX_URL:-http://127.0.0.1:4171}"
BRIDGE_PORT="${OPENBOT_BRIDGE_PORT:-4180}"

if [ ! -x "$MCP_BIN" ]; then
  echo "MCP server dependencies are missing. Run: pnpm install" >&2
  exit 1
fi

PROVIDER_ARGS=()
MODEL_ARGS=()
ENV_EXPORTS=()

if [ -n "${OPENBOT_UPSTREAM_BASE_URL:-}" ]; then
  # Non-ChatGPT model: run with an isolated CODEX_HOME so Codex cannot reach
  # the ChatGPT backend at all (no auth.json, no user config).
  CODEX_HOME="${OPENBOT_CODEX_HOME:-$REPO_DIR/.openbot-dev/codex-home}"
  mkdir -p "$CODEX_HOME"
  export CODEX_HOME
  if ! curl -sf "http://127.0.0.1:$BRIDGE_PORT/health" >/dev/null 2>&1; then
    echo "starting responses bridge for $OPENBOT_UPSTREAM_BASE_URL" >&2
    OPENBOT_UPSTREAM_BASE_URL="$OPENBOT_UPSTREAM_BASE_URL" \
    OPENBOT_UPSTREAM_API_KEY="${OPENBOT_UPSTREAM_API_KEY:-}" \
    OPENBOT_UPSTREAM_MODEL="${OPENBOT_UPSTREAM_MODEL:-}" \
    OPENBOT_BRIDGE_PORT="$BRIDGE_PORT" \
      nohup pnpm --dir "$REPO_DIR" --filter @openbot/responses-bridge start \
      > /tmp/openbot-bridge.log 2>&1 &
    for _ in $(seq 1 20); do
      curl -sf "http://127.0.0.1:$BRIDGE_PORT/health" >/dev/null 2>&1 && break
      sleep 0.5
    done
  fi
  PROVIDER_ARGS=(
    -c 'model_provider="openbot"'
    -c "model_providers.openbot={name=\"OpenBot bridge\", base_url=\"http://127.0.0.1:$BRIDGE_PORT/v1\", env_key=\"OPENBOT_UPSTREAM_API_KEY\", wire_api=\"responses\"}"
    -c 'features.apps=false'
    -c 'features.remote_plugin=false'
  )
  if [ -n "${OPENBOT_UPSTREAM_MODEL:-}" ]; then
    MODEL_ARGS=(-m "$OPENBOT_UPSTREAM_MODEL")
  fi
  ENV_EXPORTS=(OPENBOT_UPSTREAM_API_KEY="${OPENBOT_UPSTREAM_API_KEY:-unused}")
fi

exec env "${ENV_EXPORTS[@]+"${ENV_EXPORTS[@]}"}" codex exec \
  --ignore-user-config \
  --skip-git-repo-check \
  --ephemeral \
  -s read-only \
  "${MODEL_ARGS[@]+"${MODEL_ARGS[@]}"}" \
  "${PROVIDER_ARGS[@]+"${PROVIDER_ARGS[@]}"}" \
  -c "mcp_servers.openbot={command=\"$MCP_BIN\", args=[\"$MCP_SCRIPT\"], default_tools_approval_mode=\"approve\", tool_timeout_sec=300, env={OPENBOT_BOT_ID=\"$BOT_ID\", OPENBOT_SANDBOX_URL=\"$SANDBOX_URL\"}}" \
  "$@"
