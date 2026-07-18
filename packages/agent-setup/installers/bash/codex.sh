# Codex Agent Setup fragment.

# Track upstream's maintained installer so release-metadata fixes arrive without
# waiting for a Floway update. Reviewed sources:
# https://github.com/openai/codex/blob/d3fc1950a920f98e7fa9f11056667cdf911c38df/README.md#L18-L37
# https://github.com/openai/codex/blob/d3fc1950a920f98e7fa9f11056667cdf911c38df/scripts/install/install.sh
codex_ensure_installed() {
  _discover_cli codex \
    "$HOME/.local/bin/codex" \
    "/opt/homebrew/bin/codex" \
    "/usr/local/bin/codex"
  CODEX_BIN=$DISCOVERED_BIN
  if [ "$DISCOVERED_COUNT" -gt 1 ]; then
    out_warn "multiple Codex installations detected; using $CODEX_BIN"
  fi
  if [ "$DISCOVERED_COUNT" -ge 1 ]; then
    out_info 'Codex is already installed.'
    return 0
  fi

  if [ -n "${AGENT_SETUP_TEST_INSTALL_CODEX_SCRIPT:-}" ]; then
    out_info 'Codex CLI not found; running the test installer'
    _icx_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-120}
    _run_with_timeout "$_icx_timeout" env -u SETUP_API_KEY CODEX_NON_INTERACTIVE=true bash "$AGENT_SETUP_TEST_INSTALL_CODEX_SCRIPT" </dev/null || return 1
  elif [ -n "${AGENT_SETUP_TEST_CODEX_URL:-}" ]; then
    out_info 'Codex CLI not found; running the test installer download'
    CODEX_NON_INTERACTIVE=true _download_and_run_installer "$AGENT_SETUP_TEST_CODEX_URL" || return 1
  else
    case "$(uname -s)" in
      Darwin | Linux) ;;
      *)
        out_error 'automatic Codex installation supports macOS and Linux only in the Bash installer.'
        return 1
        ;;
    esac
    if [ "$(uname -s)" = Darwin ] && command -v brew >/dev/null 2>&1; then
      out_info 'Codex CLI not found; installing with Homebrew'
      _install_brew_cask codex || return 1
    elif command -v npm >/dev/null 2>&1; then
      out_info 'Codex CLI not found; installing with npm'
      _install_npm_package '@openai/codex' || return 1
    else
      out_info 'Codex CLI not found; installing from GitHub'
      CODEX_NON_INTERACTIVE=true _download_and_run_installer 'https://raw.githubusercontent.com/openai/codex/refs/heads/main/scripts/install/install.sh' || return 1
    fi
  fi
  hash -r 2>/dev/null || true
  _discover_cli codex \
    "$HOME/.local/bin/codex" \
    "/opt/homebrew/bin/codex" \
    "/usr/local/bin/codex"
  CODEX_BIN=$DISCOVERED_BIN
  [ "$DISCOVERED_COUNT" -ge 1 ]
}

# Back up the config and provider token before any mutation, recording the
# absence of each so rollback can distinguish "restore" from "remove". The
# token backup must be owner-only before the transaction can continue.
codex_backup_files() {
  CODEX_CONFIG_EXISTED=0
  CODEX_TOKEN_EXISTED=0
  CODEX_CONFIG_BACKUP=""
  CODEX_TOKEN_BACKUP=""
  _cbf_stamp=$(date +%Y%m%d%H%M%S).$$
  if [ -e "$CODEX_CONFIG_PATH" ]; then
    CODEX_CONFIG_EXISTED=1
    CODEX_CONFIG_BACKUP="$CODEX_CONFIG_PATH.floway-backup.$_cbf_stamp"
    if ! cp "$CODEX_CONFIG_PATH" "$CODEX_CONFIG_BACKUP"; then
      out_error "could not back up $CODEX_CONFIG_PATH"
      return 1
    fi
  fi
  if [ -e "$CODEX_TOKEN_PATH" ]; then
    CODEX_TOKEN_EXISTED=1
    CODEX_TOKEN_BACKUP="$CODEX_TOKEN_PATH.floway-backup.$_cbf_stamp"
    if ! cp "$CODEX_TOKEN_PATH" "$CODEX_TOKEN_BACKUP"; then
      out_error "could not back up $CODEX_TOKEN_PATH"
      return 1
    fi
    if ! chmod 600 "$CODEX_TOKEN_BACKUP"; then
      rm -f "$CODEX_TOKEN_BACKUP"
      CODEX_TOKEN_BACKUP=""
      out_error "could not protect the backup of $CODEX_TOKEN_PATH"
      return 1
    fi
  fi
}

# Both restores are attempted even when the first fails.
codex_rollback() {
  _cxr_rc=0
  _restore_managed_file \
    "${CODEX_CONFIG_EXISTED:-0}" "${CODEX_CONFIG_BACKUP:-}" "$CODEX_CONFIG_PATH" \
    "file" "Codex config" || _cxr_rc=1
  _restore_managed_file \
    "${CODEX_TOKEN_EXISTED:-0}" "${CODEX_TOKEN_BACKUP:-}" "$CODEX_TOKEN_PATH" \
    "provider token" "Codex provider token" || _cxr_rc=1
  return "$_cxr_rc"
}

codex_commit_files() {
  _prune_managed_backups "$CODEX_CONFIG_PATH" "$CODEX_CONFIG_BACKUP" || return 1
  _prune_managed_backups "$CODEX_TOKEN_PATH" "$CODEX_TOKEN_BACKUP" || return 1
  if [ -n "$CODEX_TOKEN_BACKUP" ] && ! rm -f "$CODEX_TOKEN_BACKUP"; then
    out_error "could not remove provider-token backup $CODEX_TOKEN_BACKUP"
    return 1
  fi
  CODEX_TOKEN_BACKUP=""
}

# Terminate the app-server process group, giving a child whose stdin was just
# closed a brief moment to exit on its own before escalating TERM then KILL. The
# child is launched under job control so the whole descendant tree shares one
# group. The natural-exit grace uses sub-second polling so a clean handshake
# adds negligible latency.
_codex_kill_group() {
  _ckg_pid=$1
  _ckg_n=0
  while kill -0 "$_ckg_pid" 2>/dev/null && [ "$_ckg_n" -lt 5 ]; do
    sleep 0.2
    _ckg_n=$((_ckg_n + 1))
  done
  if kill -0 "$_ckg_pid" 2>/dev/null; then
    kill -TERM -- "-$_ckg_pid" 2>/dev/null || kill -TERM "$_ckg_pid" 2>/dev/null || true
    sleep 0.5
    kill -KILL -- "-$_ckg_pid" 2>/dev/null || kill -KILL "$_ckg_pid" 2>/dev/null || true
  fi
  wait "$_ckg_pid" 2>/dev/null || true
}

# Read newline-delimited JSON-RPC from fd 4 until a response whose id matches
# $1 arrives, demultiplexing unrelated notifications. Bounded by the absolute
# CODEX_APPSERVER_DEADLINE. Returns 0 with the line in CODEX_APPSERVER_RESPONSE,
# 124 on deadline, 1 on a premature stream EOF, 2 on a malformed (unparseable)
# line, and 3 on a matching JSON-RPC error response.
_codex_read_response() {
  _crr_id=$1
  while :; do
    _crr_left=$(( CODEX_APPSERVER_DEADLINE - $(date +%s) ))
    if [ "$_crr_left" -le 0 ]; then
      return 124
    fi
    if IFS= read -r -t "$_crr_left" _crr_line <&4; then
      [ -n "$_crr_line" ] || continue
      _crr_kind=$(printf '%s\n' "$_crr_line" | "$JQ" -r --argjson want "$_crr_id" '
        if (.id == $want) then (if has("error") then "error" elif has("result") then "result" else "pending" end) else "skip" end
      ' 2>/dev/null)
      if [ -z "$_crr_kind" ]; then
        return 2
      fi
      case "$_crr_kind" in
        result) CODEX_APPSERVER_RESPONSE=$_crr_line; return 0 ;;
        error) CODEX_APPSERVER_RESPONSE=$_crr_line; return 3 ;;
        *) continue ;;
      esac
    else
      _crr_rc=$?
      if [ "$_crr_rc" -gt 128 ]; then
        return 124
      fi
      return 1
    fi
  done
}

# Drive `codex app-server` over two private FIFOs: initialize -> initialized ->
# config/batchWrite. stdin is kept open (fd 3) until the batch response arrives
# on fd 4, so a server that answers after a delay still completes. The child
# runs in its own process group for tree-wide termination; trap-invoked cleanup
# removes the working directory. On success the raw batchWrite result JSON is the
# only thing written to stdout (progress and errors go to stderr).
codex_app_server_batch_write() {
  _cas_edits=$1
  _cas_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-60}
  _cas_dir=$(mktemp -d "$SETUP_TMPDIR/codex-appserver.XXXXXX") || return 1
  _cas_req="$_cas_dir/req"
  _cas_res="$_cas_dir/res"
  if ! mkfifo "$_cas_req" "$_cas_res"; then
    rm -rf "$_cas_dir"
    return 1
  fi

  set -m
  "$CODEX_BIN" app-server --listen stdio:// <"$_cas_req" >"$_cas_res" 2>"$_cas_dir/stderr" &
  _cas_pid=$!
  set +m

  # Open the write end of req first (this unblocks the child's stdin open), then
  # the read end of res. This ordering is what keeps a FIFO pair from deadlocking.
  exec 3>"$_cas_req"
  exec 4<"$_cas_res"

  CODEX_APPSERVER_DEADLINE=$(( $(date +%s) + _cas_timeout ))
  CODEX_APPSERVER_RESPONSE=""
  _cas_status=0

  _cas_init=$("$JQ" -cn '{jsonrpc:"2.0",id:1,method:"initialize",params:{clientInfo:{name:"floway-setup",title:null,version:"1"},capabilities:null}}')
  printf '%s\n' "$_cas_init" >&3 2>/dev/null || _cas_status=1
  if [ "$_cas_status" -eq 0 ]; then
    _codex_read_response 1
    _cas_status=$?
  fi
  if [ "$_cas_status" -eq 0 ]; then
    printf '%s\n' '{"jsonrpc":"2.0","method":"initialized"}' >&3 2>/dev/null || _cas_status=1
  fi
  if [ "$_cas_status" -eq 0 ]; then
    _cas_batch=$("$JQ" -cn --argjson edits "$_cas_edits" '{jsonrpc:"2.0",id:2,method:"config/batchWrite",params:{edits:$edits}}')
    printf '%s\n' "$_cas_batch" >&3 2>/dev/null || _cas_status=1
  fi
  _cas_result=""
  if [ "$_cas_status" -eq 0 ]; then
    _codex_read_response 2
    _cas_status=$?
    _cas_result=$CODEX_APPSERVER_RESPONSE
  fi

  exec 3>&- 2>/dev/null || true
  exec 4<&- 2>/dev/null || true
  _codex_kill_group "$_cas_pid"
  rm -rf "$_cas_dir"

  if [ "$_cas_status" -ne 0 ]; then
    return "$_cas_status"
  fi
  printf '%s' "$_cas_result"
}

# Build the base-config edit batch and write it through the app-server. Model
# and effort are opaque, forwarded verbatim, and cleared with JSON null when
# unset. A batch status of `ok` or `okOverridden` confirms the intended base
# config; `okOverridden` is reported with its non-secret layer metadata.
codex_write_config() {
  _cwc_base="${SETUP_ENDPOINT%/}/azure-api.codex"
  # Command auth opts a provider into online model refresh. The actor marker
  # enables Codex's client-owned search and image extensions for this provider.
  # https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/models-manager/src/manager.rs#L413-L415
  # https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/model-provider-info/src/lib.rs#L396-L408
  # standalone_web_search is under development, so its explicit opt-in is
  # paired with the top-level warning suppression instead of warning every run.
  # https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L901-L905
  # https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L1393-L1439
  _cwc_edits=$("$JQ" -cn \
    --arg base "$_cwc_base" \
    --arg model "$SETUP_CODEX_MODEL" \
    --arg effort "$SETUP_CODEX_REASONING_EFFORT" '
    [
      {keyPath:"model_provider",mergeStrategy:"replace",value:"floway"},
      {keyPath:"suppress_unstable_features_warning",mergeStrategy:"replace",value:true},
      {keyPath:"model_providers.floway.name",mergeStrategy:"replace",value:"Floway"},
      {keyPath:"model_providers.floway.base_url",mergeStrategy:"replace",value:$base},
      {keyPath:"model_providers.floway.auth",mergeStrategy:"replace",value:{command:"sh",args:["-c","cat \"${CODEX_HOME:-$HOME/.codex}/floway-token\""]}},
      {keyPath:"model_providers.floway.wire_api",mergeStrategy:"replace",value:"responses"},
      {keyPath:"model_providers.floway.supports_websockets",mergeStrategy:"replace",value:true},
      {keyPath:"model_providers.floway.http_headers",mergeStrategy:"replace",value:{"x-openai-actor-authorization":"1"}},
      {keyPath:"features.apps",mergeStrategy:"replace",value:false},
      {keyPath:"features.standalone_web_search",mergeStrategy:"replace",value:true},
      {keyPath:"model",mergeStrategy:"replace",value:(if $model == "" then null else $model end)},
      {keyPath:"model_reasoning_effort",mergeStrategy:"replace",value:(if $effort == "" then null else $effort end)}
    ]') || {
    out_error 'could not build the Codex configuration edits.'
    return 1
  }

  _cwc_result=$(codex_app_server_batch_write "$_cwc_edits")
  _cwc_rc=$?
  if [ "$_cwc_rc" -ne 0 ]; then
    case "$_cwc_rc" in
      124) out_error 'the Codex app-server timed out before confirming the configuration.' ;;
      3) out_error 'the Codex app-server reported an error writing the configuration.' ;;
      2) out_error 'the Codex app-server returned a malformed response.' ;;
      1) out_error 'the Codex app-server exited before confirming the configuration.' ;;
      *) out_error 'the Codex app-server configuration failed.' ;;
    esac
    return 1
  fi

  _cwc_status=$(printf '%s' "$_cwc_result" | "$JQ" -r '.result.status // empty' 2>/dev/null)
  case "$_cwc_status" in
    ok) ;;
    okOverridden)
      _cwc_msg=$(printf '%s' "$_cwc_result" | "$JQ" -r '.result.overriddenMetadata.message // "an override layer applies"' 2>/dev/null)
      _cwc_layer=$(printf '%s' "$_cwc_result" | "$JQ" -r '.result.overriddenMetadata.overridingLayer.name.type // "unknown"' 2>/dev/null)
      out_warn "Codex configuration is overridden by a higher-precedence layer ($_cwc_msg; layer: $_cwc_layer)."
      ;;
    *)
      out_error "the Codex app-server did not confirm the configuration (status: ${_cwc_status:-none})."
      return 1
      ;;
  esac
  CODEX_WRITTEN_CONFIG_PATH=$(printf '%s' "$_cwc_result" | "$JQ" -r '.result.filePath // empty' 2>/dev/null)
  if [ -z "$CODEX_WRITTEN_CONFIG_PATH" ]; then
    out_error 'the Codex app-server did not report the written config path.'
    return 1
  fi
}

# Store the selected API key as a provider-scoped command-auth token. The private
# stage is validated byte-for-byte, then atomically renamed. auth.json is an
# account-owned Codex file and is never read or changed here.
codex_stage_token() {
  _cst_stage="$CODEX_TOKEN_PATH.floway-stage.$$"
  if ! (umask 077 && : > "$_cst_stage"); then
    out_error 'could not create the Codex provider-token stage.'
    return 1
  fi
  if ! printf '%s' "$SETUP_API_KEY" > "$_cst_stage"; then
    out_error 'could not write the Codex provider-token stage.'
    rm -f "$_cst_stage"
    return 1
  fi
  if ! cmp -s "$_cst_stage" <(printf '%s' "$SETUP_API_KEY"); then
    out_error 'staged Codex provider token failed validation.'
    rm -f "$_cst_stage"
    return 1
  fi
  if ! chmod 600 "$_cst_stage"; then
    rm -f "$_cst_stage"
    return 1
  fi
  if ! mv "$_cst_stage" "$CODEX_TOKEN_PATH"; then
    out_error "could not replace $CODEX_TOKEN_PATH"
    rm -f "$_cst_stage"
    return 1
  fi
}

codex_write_version() {
  _cv_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-30}
  _cv_version_file="$SETUP_TMPDIR/codex-version.out"
  if _run_with_timeout "$_cv_timeout" "$CODEX_BIN" --version > "$_cv_version_file" 2>&1; then
    out_info "Codex version: $(cat "$_cv_version_file")"
  else
    _cv_version_status=$?
    if [ "$_cv_version_status" -eq 124 ]; then
      out_error '`codex --version` timed out.'
    else
      out_error '`codex --version` failed.'
    fi
    return 1
  fi
}

# Install, then configure Codex as one transactional config/token write. A
# freshly installed CLI is never uninstalled when configuration fails.
configure_agent() {
  out_agent_notice 'Installing' 'Codex'
  if ! codex_ensure_installed; then
    out_error 'Codex CLI is unavailable and could not be installed.'
    return 1
  fi
  if ! codex_write_version; then
    return 1
  fi

  out_agent_notice 'Configuring' 'Codex'
  if ! ensure_jq; then
    out_error 'jq is required to configure Codex but is unavailable and could not be provisioned for this platform. Install jq and re-run.'
    return 1
  fi
  CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
  CODEX_CONFIG_PATH="$CODEX_HOME_DIR/config.toml"
  CODEX_TOKEN_PATH="$CODEX_HOME_DIR/floway-token"
  if ! mkdir -p "$CODEX_HOME_DIR"; then
    out_error "could not create $CODEX_HOME_DIR"
    return 1
  fi
  if ! codex_backup_files; then
    return 1
  fi
  if ! codex_stage_token; then
    out_warn 'Codex provider-token staging failed; rolling back configuration and token.'
    codex_rollback
    return 1
  fi
  if ! codex_write_config; then
    out_warn 'Codex configuration failed; rolling back configuration and token.'
    codex_rollback
    return 1
  fi
  if ! codex_commit_files; then
    out_warn 'Codex backup cleanup failed; rolling back configuration and token.'
    codex_rollback
    return 1
  fi
  out_info "Written to \`$CODEX_WRITTEN_CONFIG_PATH\`."
  out_info "Written to \`$CODEX_TOKEN_PATH\`."
  out_agent_notice 'Completed Agent Setup' 'Codex'
}


main 'Codex' "$@"
