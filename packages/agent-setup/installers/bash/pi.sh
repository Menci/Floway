# Pi Agent Setup fragment.

# Track upstream's maintained installer so release-metadata fixes arrive without
# waiting for a Floway update. Reviewed sources:
# https://pi.dev
# https://github.com/earendil-works/pi-mono
# https://pi.dev/install.sh

pi_check_node() {
  if ! command -v node >/dev/null 2>&1; then
    out_error 'Node.js (>= 22.19) is required to run Pi but was not found on PATH. Install Node.js (>= 22.19) and re-run.'
    return 1
  fi
  _node_ver=$(node -v 2>/dev/null || true)
  _node_ver="${_node_ver#v}"
  _node_major="${_node_ver%%.*}"
  _node_rest="${_node_ver#*.}"
  _node_minor="${_node_rest%%.*}"
  if [ -n "$_node_major" ] && [ -n "$_node_minor" ]; then
    if [ "$_node_major" -lt 22 ] 2>/dev/null || { [ "$_node_major" -eq 22 ] && [ "$_node_minor" -lt 19 ]; } 2>/dev/null; then
      out_warn "Node.js version is v$_node_ver; Pi requires Node.js >= 22.19."
    fi
  fi
  return 0
}

pi_ensure_installed() {
  _discover_cli pi \
    "$HOME/.local/bin/pi" \
    "$HOME/.bun/bin/pi" \
    "/opt/homebrew/bin/pi" \
    "/usr/local/bin/pi"
  PI_BIN=$DISCOVERED_BIN
  if [ "$DISCOVERED_COUNT" -gt 1 ]; then
    out_warn "multiple Pi installations detected; using $PI_BIN"
  fi
  if [ "$DISCOVERED_COUNT" -ge 1 ]; then
    out_info 'Pi is already installed.'
    return 0
  fi

  if [ -n "${AGENT_SETUP_TEST_INSTALL_PI_SCRIPT:-}" ]; then
    out_info 'Pi CLI not found; running the test installer'
    _ipi_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-120}
    _run_with_timeout "$_ipi_timeout" env -u SETUP_API_KEY bash "$AGENT_SETUP_TEST_INSTALL_PI_SCRIPT" </dev/null || return 1
  elif [ -n "${AGENT_SETUP_TEST_PI_URL:-}" ]; then
    out_info 'Pi CLI not found; running the test installer download'
    _download_and_run_installer "$AGENT_SETUP_TEST_PI_URL" || return 1
  else
    case "$(uname -s)" in
      Darwin | Linux) ;;
      *)
        out_error 'automatic Pi installation supports macOS and Linux only in the Bash installer.'
        return 1
        ;;
    esac
    if command -v npm >/dev/null 2>&1; then
      out_info 'Pi CLI not found; installing with npm'
      _install_npm_package '@earendil-works/pi-coding-agent' || return 1
    else
      out_info 'Pi CLI not found; installing from pi.dev'
      _download_and_run_installer 'https://pi.dev/install.sh' || return 1
    fi
  fi
  hash -r 2>/dev/null || true
  _discover_cli pi \
    "$HOME/.local/bin/pi" \
    "$HOME/.bun/bin/pi" \
    "/opt/homebrew/bin/pi" \
    "/usr/local/bin/pi"
  PI_BIN=$DISCOVERED_BIN
  [ "$DISCOVERED_COUNT" -ge 1 ]
}

pi_write_version() {
  _pv_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-30}
  _pv_version_file="$SETUP_TMPDIR/pi-version.out"
  if _run_with_timeout "$_pv_timeout" "$PI_BIN" --version > "$_pv_version_file" 2>&1; then
    out_info "Pi version: $(cat "$_pv_version_file")"
  else
    _pv_version_status=$?
    if [ "$_pv_version_status" -eq 124 ]; then
      out_error '`pi --version` timed out.'
    else
      out_error '`pi --version` failed.'
    fi
    return 1
  fi
}

pi_resolve_agent_dir() {
  PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  PI_MODELS_PATH="$PI_AGENT_DIR/models.json"
  PI_SETTINGS_PATH="$PI_AGENT_DIR/settings.json"
  return 0
}

pi_backup_files() {
  PI_MODELS_EXISTED=0
  PI_SETTINGS_EXISTED=0
  PI_MODELS_BACKUP=""
  PI_SETTINGS_BACKUP=""
  _pbf_stamp=$(date +%Y%m%d%H%M%S).$$
  if [ -e "$PI_MODELS_PATH" ]; then
    PI_MODELS_EXISTED=1
    PI_MODELS_BACKUP="$PI_MODELS_PATH.floway-backup.$_pbf_stamp"
    if ! cp "$PI_MODELS_PATH" "$PI_MODELS_BACKUP"; then
      out_error "could not back up $PI_MODELS_PATH"
      return 1
    fi
    if ! chmod 600 "$PI_MODELS_BACKUP"; then
      rm -f "$PI_MODELS_BACKUP"
      PI_MODELS_BACKUP=""
      out_error "could not protect the backup of $PI_MODELS_PATH"
      return 1
    fi
  fi
  if [ -e "$PI_SETTINGS_PATH" ]; then
    PI_SETTINGS_EXISTED=1
    PI_SETTINGS_BACKUP="$PI_SETTINGS_PATH.floway-backup.$_pbf_stamp"
    if ! cp "$PI_SETTINGS_PATH" "$PI_SETTINGS_BACKUP"; then
      out_error "could not back up $PI_SETTINGS_PATH"
      return 1
    fi
    if ! chmod 600 "$PI_SETTINGS_BACKUP"; then
      rm -f "$PI_SETTINGS_BACKUP"
      PI_SETTINGS_BACKUP=""
      out_error "could not protect the backup of $PI_SETTINGS_PATH"
      return 1
    fi
  fi
  return 0
}

pi_rollback() {
  _prb_rc=0
  _restore_managed_file \
    "${PI_MODELS_EXISTED:-0}" "${PI_MODELS_BACKUP:-}" "$PI_MODELS_PATH" \
    "models file" "Pi models configuration" || _prb_rc=1
  _restore_managed_file \
    "${PI_SETTINGS_EXISTED:-0}" "${PI_SETTINGS_BACKUP:-}" "$PI_SETTINGS_PATH" \
    "settings file" "Pi settings configuration" || _prb_rc=1
  if [ -n "${PI_MODELS_STAGE:-}" ]; then
    rm -f "$PI_MODELS_STAGE"
    PI_MODELS_STAGE=""
  fi
  if [ -n "${PI_SETTINGS_STAGE:-}" ]; then
    rm -f "$PI_SETTINGS_STAGE"
    PI_SETTINGS_STAGE=""
  fi
  return "$_prb_rc"
}

pi_commit_files() {
  if [ -n "$PI_MODELS_BACKUP" ]; then
    _prune_managed_backups "$PI_MODELS_PATH" "$PI_MODELS_BACKUP" || return 1
    if ! rm -f "$PI_MODELS_BACKUP"; then
      out_error "could not remove models backup $PI_MODELS_BACKUP"
      return 1
    fi
    PI_MODELS_BACKUP=""
  else
    _prune_managed_backups "$PI_MODELS_PATH" "" || return 1
  fi

  if [ -n "$PI_SETTINGS_BACKUP" ]; then
    _prune_managed_backups "$PI_SETTINGS_PATH" "$PI_SETTINGS_BACKUP" || return 1
    if ! rm -f "$PI_SETTINGS_BACKUP"; then
      out_error "could not remove settings backup $PI_SETTINGS_BACKUP"
      return 1
    fi
    PI_SETTINGS_BACKUP=""
  else
    _prune_managed_backups "$PI_SETTINGS_PATH" "" || return 1
  fi
  return 0
}

pi_ensure_editor() {
  _editor="$SETUP_TMPDIR/jsonc-edit.mjs"
  if [ -f "$_editor" ]; then
    return 0
  fi
  if type _write_jsonc_editor >/dev/null 2>&1; then
    _write_jsonc_editor
    return 0
  fi
  _repo_editor="$(dirname "$0")/../node/jsonc-edit.mjs"
  if [ -f "$_repo_editor" ]; then
    cp "$_repo_editor" "$_editor"
    return 0
  fi
  out_error 'JSONC editor asset missing from installer.'
  return 1
}

pi_fetch_snapshot() {
  _pfs_snapshot="$SETUP_TMPDIR/snapshot.json"
  _pfs_url="${AGENT_SETUP_TEST_PI_MODELS_URL:-${SETUP_ENDPOINT%/}/api/setup/${SETUP_TOKEN:-}/pi-models.json}"
  if ! curl -fsSL --connect-timeout 10 --max-time 60 -o "$_pfs_snapshot" "$_pfs_url"; then
    out_error "failed to fetch model snapshot from $_pfs_url"
    return 1
  fi
  chmod 600 "$_pfs_snapshot" 2>/dev/null || true
  PI_SNAPSHOT_FILE="$_pfs_snapshot"
  return 0
}

pi_stage_models() {
  PI_MODELS_STAGE="$PI_MODELS_PATH.floway-stage.$$"
  _psm_err="$SETUP_TMPDIR/models-edit.err"

  _psm_node_cmd=(
    env
    FLOWAY_SNAPSHOT_FILE="$PI_SNAPSHOT_FILE"
    FLOWAY_BASE_URL="${SETUP_ENDPOINT%/}"
    FLOWAY_API_KEY="$SETUP_API_KEY"
    node "$SETUP_TMPDIR/jsonc-edit.mjs" models
  )

  if [ -f "$PI_MODELS_PATH" ]; then
    "${_psm_node_cmd[@]}" < "$PI_MODELS_PATH" > "$PI_MODELS_STAGE" 2> "$_psm_err" || _psm_rc=$?
  else
    "${_psm_node_cmd[@]}" < /dev/null > "$PI_MODELS_STAGE" 2> "$_psm_err" || _psm_rc=$?
  fi
  _psm_rc=${_psm_rc:-0}

  if [ "$_psm_rc" -ne 0 ]; then
    _psm_msg=$(cat "$_psm_err" 2>/dev/null || true)
    out_error "failed to update $PI_MODELS_PATH: ${_psm_msg:-unknown error}"
    rm -f "$PI_MODELS_STAGE" "$_psm_err"
    PI_MODELS_STAGE=""
    return 1
  fi
  rm -f "$_psm_err"

  # The editor always emits a JSON object. An empty file means it did not run.
  if [ ! -s "$PI_MODELS_STAGE" ]; then
    out_error "Node.js editor produced no output; refusing to write an empty configuration"
    rm -f "$PI_MODELS_STAGE"
    PI_MODELS_STAGE=""
    return 1
  fi

  if ! chmod 600 "$PI_MODELS_STAGE"; then
    out_error "could not protect staged models configuration $PI_MODELS_STAGE"
    rm -f "$PI_MODELS_STAGE"
    PI_MODELS_STAGE=""
    return 1
  fi
  return 0
}

pi_stage_settings() {
  if [ -z "${SETUP_PI_MODEL:-}" ] && [ ! -f "$PI_SETTINGS_PATH" ]; then
    PI_SETTINGS_STAGE=""
    return 0
  fi

  PI_SETTINGS_STAGE="$PI_SETTINGS_PATH.floway-stage.$$"
  _pss_err="$SETUP_TMPDIR/settings-edit.err"

  if [ -n "${SETUP_PI_MODEL:-}" ]; then
    _pss_model_env="FLOWAY_DEFAULT_MODEL=$SETUP_PI_MODEL"
    _pss_remove_env="FLOWAY_REMOVE_DEFAULT_MODEL=0"
  else
    _pss_model_env="FLOWAY_DEFAULT_MODEL="
    _pss_remove_env="FLOWAY_REMOVE_DEFAULT_MODEL=1"
  fi

  _pss_node_cmd=(
    env "$_pss_model_env" "$_pss_remove_env"
    node "$SETUP_TMPDIR/jsonc-edit.mjs" settings
  )

  if [ -f "$PI_SETTINGS_PATH" ]; then
    "${_pss_node_cmd[@]}" < "$PI_SETTINGS_PATH" > "$PI_SETTINGS_STAGE" 2> "$_pss_err" || _pss_rc=$?
  else
    "${_pss_node_cmd[@]}" < /dev/null > "$PI_SETTINGS_STAGE" 2> "$_pss_err" || _pss_rc=$?
  fi
  _pss_rc=${_pss_rc:-0}

  if [ "$_pss_rc" -ne 0 ]; then
    _pss_msg=$(cat "$_pss_err" 2>/dev/null || true)
    out_error "failed to update $PI_SETTINGS_PATH: ${_pss_msg:-unknown error}"
    rm -f "$PI_SETTINGS_STAGE" "$_pss_err"
    PI_SETTINGS_STAGE=""
    return 1
  fi
  rm -f "$_pss_err"

  # The editor always emits a JSON object. An empty file means it did not run.
  if [ ! -s "$PI_SETTINGS_STAGE" ]; then
    out_error "Node.js editor produced no output; refusing to write an empty configuration"
    rm -f "$PI_SETTINGS_STAGE"
    PI_SETTINGS_STAGE=""
    return 1
  fi

  if ! chmod 600 "$PI_SETTINGS_STAGE"; then
    out_error "could not protect staged settings configuration $PI_SETTINGS_STAGE"
    rm -f "$PI_SETTINGS_STAGE"
    PI_SETTINGS_STAGE=""
    return 1
  fi
  return 0
}

pi_apply_staged() {
  if ! mv "$PI_MODELS_STAGE" "$PI_MODELS_PATH"; then
    out_error "could not replace $PI_MODELS_PATH"
    rm -f "$PI_MODELS_STAGE"
    return 1
  fi
  chmod 600 "$PI_MODELS_PATH" 2>/dev/null || true
  PI_MODELS_STAGE=""

  if [ -n "$PI_SETTINGS_STAGE" ]; then
    if ! mv "$PI_SETTINGS_STAGE" "$PI_SETTINGS_PATH"; then
      out_error "could not replace $PI_SETTINGS_PATH"
      rm -f "$PI_SETTINGS_STAGE"
      return 1
    fi
    chmod 600 "$PI_SETTINGS_PATH" 2>/dev/null || true
    PI_SETTINGS_STAGE=""
  fi
  return 0
}

configure_agent() {
  out_agent_notice 'Installing' 'Pi'
  if ! pi_check_node; then
    return 1
  fi
  if ! pi_ensure_installed; then
    out_error 'Pi CLI is unavailable and could not be installed.'
    return 1
  fi
  if ! pi_write_version; then
    return 1
  fi

  out_agent_notice 'Configuring' 'Pi'
  if ! pi_resolve_agent_dir; then
    return 1
  fi
  if ! mkdir -p "$PI_AGENT_DIR"; then
    out_error "could not create $PI_AGENT_DIR"
    return 1
  fi

  if ! pi_backup_files; then
    return 1
  fi

  if ! pi_ensure_editor; then
    pi_rollback
    return 1
  fi

  if ! pi_fetch_snapshot; then
    pi_rollback
    return 1
  fi

  if ! pi_stage_models; then
    out_warn 'Pi models staging failed; rolling back configuration.'
    pi_rollback
    return 1
  fi

  if [ -n "${AGENT_SETUP_TEST_FAIL_CONFIG:-}" ]; then
    out_warn 'Pi simulated failure; rolling back configuration.'
    pi_rollback
    return 1
  fi

  if ! pi_stage_settings; then
    out_warn 'Pi settings staging failed; rolling back configuration.'
    pi_rollback
    return 1
  fi

  if ! pi_apply_staged; then
    out_warn 'Pi applying changes failed; rolling back configuration.'
    pi_rollback
    return 1
  fi

  if ! pi_commit_files; then
    out_warn 'Pi backup cleanup failed; rolling back configuration.'
    pi_rollback
    return 1
  fi

  out_info "Written to \`$PI_MODELS_PATH\`."
  if [ -e "$PI_SETTINGS_PATH" ]; then
    out_info "Written to \`$PI_SETTINGS_PATH\`."
  fi
  out_info 'Models configured as a static snapshot; re-run this setup command at any time to refresh the model list.'
  out_agent_notice 'Completed Agent Setup' 'Pi'
}

main 'Pi' "$@"
