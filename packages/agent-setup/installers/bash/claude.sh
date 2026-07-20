# Claude Code Agent Setup fragment.

# Managed-key merge applied to the existing Claude settings document. Only the
# keys the setup owns are touched; every unrelated key and env var is preserved.
# An empty optional value means "remove that managed key". The API key is read
# from the environment (`env.SETUP_API_KEY`) so it stays out of argv.
# Refs: https://docs.claude.com/en/docs/claude-code/env-vars
#       https://docs.claude.com/en/docs/claude-code/model-config#environment-variables
#       https://docs.claude.com/en/docs/claude-code/settings
#       https://code.claude.com/docs/en/settings#attribution-settings
CLAUDE_MERGE_PROGRAM='
  if type != "object" then error("root is not a JSON object")
  elif (has("env") and ((.env | type) != "object")) then error("env is not a JSON object")
  elif (has("attribution") and ((.attribution | type) != "object")) then error("attribution is not a JSON object")
  else . end
  | (if (has("env") | not) then .env = {} else . end)
  | .env.ANTHROPIC_BASE_URL = $baseUrl
  | .env.ANTHROPIC_AUTH_TOKEN = env.SETUP_API_KEY
  | (if $model == "" then del(.env.ANTHROPIC_MODEL) else .env.ANTHROPIC_MODEL = $model end)
  | (if $opus == "" then del(.env.ANTHROPIC_DEFAULT_OPUS_MODEL) else .env.ANTHROPIC_DEFAULT_OPUS_MODEL = $opus end)
  | (if $sonnet == "" then del(.env.ANTHROPIC_DEFAULT_SONNET_MODEL) else .env.ANTHROPIC_DEFAULT_SONNET_MODEL = $sonnet end)
  | (if $haiku == "" then del(.env.ANTHROPIC_DEFAULT_HAIKU_MODEL) else .env.ANTHROPIC_DEFAULT_HAIKU_MODEL = $haiku end)
  | (if $discovery == "1" then .env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1" else del(.env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY) end)
  | (if $effort == "" then del(.effortLevel) else .effortLevel = $effort end)
  | (if $cleanup == "" then del(.cleanupPeriodDays) else .cleanupPeriodDays = ($cleanup | tonumber) end)
  | (if $optOutAttribution == "1" then
      .attribution = ((.attribution // {}) + { "commit": "", "pr": "", "sessionUrl": false })
    else
      del(.attribution.commit, .attribution.pr, .attribution.sessionUrl)
      | (if .attribution == {} then del(.attribution) else . end)
    end)
'

# Refs:
# https://code.claude.com/docs/en/setup
# https://github.com/anthropics/claude-code/blob/c39cb0f14bfe8bb519bae5bfc55add6867c5e2ab/README.md#L13-L44
claude_ensure_installed() {
  _discover_cli claude \
    "$HOME/.local/bin/claude" \
    "$HOME/.claude/local/claude" \
    "$HOME/.bun/bin/claude" \
    "/opt/homebrew/bin/claude" \
    "/usr/local/bin/claude"
  CLAUDE_BIN=$DISCOVERED_BIN
  if [ "$DISCOVERED_COUNT" -gt 1 ]; then
    out_warn "multiple Claude Code installations detected; using $CLAUDE_BIN"
  fi
  if [ "$DISCOVERED_COUNT" -ge 1 ]; then
    out_info 'Claude Code is already installed.'
    return 0
  fi

  if [ -n "${AGENT_SETUP_TEST_INSTALL_CLAUDE_SCRIPT:-}" ]; then
    out_info 'Claude Code CLI not found; running the test installer'
    _ic_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-120}
    _run_with_timeout "$_ic_timeout" env -u SETUP_API_KEY bash "$AGENT_SETUP_TEST_INSTALL_CLAUDE_SCRIPT" </dev/null || return 1
  elif [ -n "${AGENT_SETUP_TEST_CLAUDE_URL:-}" ]; then
    out_info 'Claude Code CLI not found; running the test installer download'
    _download_and_run_installer "$AGENT_SETUP_TEST_CLAUDE_URL" || return 1
  else
    case "$(uname -s)" in
      Darwin)
        if command -v brew >/dev/null 2>&1; then
          out_info 'Claude Code CLI not found; installing with Homebrew'
          _install_brew_cask claude-code || return 1
        elif command -v npm >/dev/null 2>&1; then
          out_info 'Claude Code CLI not found; installing with npm'
          _install_npm_package '@anthropic-ai/claude-code' || return 1
        else
          out_info 'Claude Code CLI not found; installing from downloads.claude.ai'
          _download_and_run_installer 'https://downloads.claude.ai/claude-code-releases/bootstrap.sh' || return 1
        fi
        ;;
      Linux)
        if command -v npm >/dev/null 2>&1; then
          out_info 'Claude Code CLI not found; installing with npm'
          _install_npm_package '@anthropic-ai/claude-code' || return 1
        else
          out_info 'Claude Code CLI not found; installing from downloads.claude.ai'
          _download_and_run_installer 'https://downloads.claude.ai/claude-code-releases/bootstrap.sh' || return 1
        fi
        ;;
      *)
        out_error 'automatic Claude Code installation supports macOS and Linux only in the Bash installer.'
        return 1
        ;;
    esac
  fi
  hash -r 2>/dev/null || true
  _discover_cli claude \
    "$HOME/.local/bin/claude" \
    "$HOME/.claude/local/claude" \
    "$HOME/.bun/bin/claude" \
    "/opt/homebrew/bin/claude" \
    "/usr/local/bin/claude"
  CLAUDE_BIN=$DISCOVERED_BIN
  [ "$DISCOVERED_COUNT" -ge 1 ]
}

claude_rollback_settings() {
  _restore_managed_file \
    "${CLAUDE_SETTINGS_EXISTED:-0}" "${CLAUDE_SETTINGS_BACKUP:-}" "$CLAUDE_SETTINGS_PATH" \
    "file" "Claude settings"
}

# Same-directory staging keeps the mode-0600 replacement rename atomic.
claude_write_settings() {
  _cw_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  CLAUDE_SETTINGS_PATH="$_cw_dir/settings.json"
  CLAUDE_SETTINGS_BACKUP=""
  CLAUDE_SETTINGS_EXISTED=0

  if ! mkdir -p "$_cw_dir"; then
    out_error "could not create $_cw_dir"
    return 1
  fi

  if [ -e "$CLAUDE_SETTINGS_PATH" ]; then
    CLAUDE_SETTINGS_EXISTED=1
    if ! "$JQ" '
        if type != "object" then error("root is not a JSON object")
        elif (has("env") and ((.env | type) != "object")) then error("env is not a JSON object")
        elif (has("attribution") and ((.attribution | type) != "object")) then error("attribution is not a JSON object")
        else . end
      ' "$CLAUDE_SETTINGS_PATH" >/dev/null 2>&1; then
      out_error "$CLAUDE_SETTINGS_PATH is not valid Claude settings; leaving it untouched."
      return 1
    fi
    _cw_base=$(cat "$CLAUDE_SETTINGS_PATH")
    CLAUDE_SETTINGS_BACKUP="$CLAUDE_SETTINGS_PATH.floway-backup.$(date +%Y%m%d%H%M%S).$$"
    if ! cp "$CLAUDE_SETTINGS_PATH" "$CLAUDE_SETTINGS_BACKUP"; then
      out_error "could not back up $CLAUDE_SETTINGS_PATH"
      return 1
    fi
  else
    _cw_base='{}'
  fi

  _cw_stage="$CLAUDE_SETTINGS_PATH.floway-stage.$$"
  if ! printf '%s' "$_cw_base" | SETUP_API_KEY="$SETUP_API_KEY" "$JQ" \
      --arg baseUrl "$SETUP_ENDPOINT" \
      --arg model "$SETUP_CLAUDE_MODEL" \
      --arg opus "$SETUP_CLAUDE_DEFAULT_OPUS_MODEL" \
      --arg sonnet "$SETUP_CLAUDE_DEFAULT_SONNET_MODEL" \
      --arg haiku "$SETUP_CLAUDE_DEFAULT_HAIKU_MODEL" \
      --arg discovery "$SETUP_CLAUDE_MODEL_DISCOVERY" \
      --arg effort "$SETUP_CLAUDE_EFFORT_LEVEL" \
      --arg cleanup "$SETUP_CLAUDE_CLEANUP_PERIOD_DAYS" \
      --arg optOutAttribution "$SETUP_CLAUDE_OPT_OUT_AI_ATTRIBUTION" \
      "$CLAUDE_MERGE_PROGRAM" > "$_cw_stage"; then
    out_error 'failed to construct updated Claude settings.'
    rm -f "$_cw_stage"
    claude_rollback_settings
    return 1
  fi

  if ! SETUP_API_KEY="$SETUP_API_KEY" "$JQ" -e --arg baseUrl "$SETUP_ENDPOINT" '
      (type == "object")
      and ((.env | type) == "object")
      and (.env.ANTHROPIC_BASE_URL == $baseUrl)
      and (.env.ANTHROPIC_AUTH_TOKEN == env.SETUP_API_KEY)
    ' "$_cw_stage" >/dev/null 2>&1; then
    out_error 'staged Claude settings failed validation.'
    rm -f "$_cw_stage"
    claude_rollback_settings
    return 1
  fi

  if ! chmod 600 "$_cw_stage"; then
    rm -f "$_cw_stage"
    claude_rollback_settings
    return 1
  fi

  if ! mv "$_cw_stage" "$CLAUDE_SETTINGS_PATH"; then
    out_error "could not replace $CLAUDE_SETTINGS_PATH"
    rm -f "$_cw_stage"
    claude_rollback_settings
    return 1
  fi
  if ! _prune_managed_backups "$CLAUDE_SETTINGS_PATH" "$CLAUDE_SETTINGS_BACKUP"; then
    claude_rollback_settings
    return 1
  fi
}

claude_write_version() {
  _cv_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-30}
  _cv_version_file="$SETUP_TMPDIR/claude-version.out"
  if _run_with_timeout "$_cv_timeout" "$CLAUDE_BIN" --version > "$_cv_version_file" 2>&1; then
    _cv_version=$(cat "$_cv_version_file")
  else
    _cv_version_status=$?
    if [ "$_cv_version_status" -eq 124 ]; then
      out_error '`claude --version` timed out.'
    else
      out_error '`claude --version` failed.'
    fi
    return 1
  fi
  out_info "Claude Code version: $_cv_version"
}

# Install, then configure Claude Code as one transactional settings write. A
# freshly installed CLI is never uninstalled when configuration fails.
configure_agent() {
  out_agent_notice 'Installing' 'Claude Code'
  if ! claude_ensure_installed; then
    out_error 'Claude Code CLI is unavailable and could not be installed.'
    return 1
  fi
  if ! claude_write_version; then
    return 1
  fi

  out_agent_notice 'Configuring' 'Claude Code'
  if ! ensure_jq; then
    out_error 'jq is required to configure Claude Code but is unavailable and could not be provisioned for this platform. Install jq and re-run.'
    return 1
  fi
  if ! claude_write_settings; then
    return 1
  fi
  out_info "Written to \`$CLAUDE_SETTINGS_PATH\`."
  out_agent_notice 'Completed Agent Setup' 'Claude Code'
}


main 'Claude Code' "$@"
