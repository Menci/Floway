# Use the maintained upstream installer so release discovery follows upstream.
# https://pi.dev/install.sh

# https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/coding-agent/package.json#L107-L109
pi_check_node() {
  if ! command -v node >/dev/null 2>&1; then
    out_error 'Node.js (>= 22.19) is required to run Pi but was not found on PATH. Install Node.js (>= 22.19) and re-run.'
    return 1
  fi
  _node_ver=$(node -v) || return $?
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

pi_discover_cli() {
  _discover_cli pi \
    "$HOME/.local/bin/pi" \
    "$HOME/.bun/bin/pi" \
    "/opt/homebrew/bin/pi" \
    "/usr/local/bin/pi"
  PI_BIN=$DISCOVERED_BIN
}

pi_ensure_installed() {
  pi_discover_cli
  if [ "$DISCOVERED_COUNT" -gt 1 ]; then
    out_warn "multiple Pi installations detected; using $PI_BIN"
  fi
  if [ "$DISCOVERED_COUNT" -ge 1 ]; then
    out_info 'Pi is already installed.'
    return 0
  fi

  pi_install
}

pi_install() {
  if [ -n "${AGENT_SETUP_TEST_INSTALL_PI_SCRIPT:-}" ]; then
    out_info 'Installing Pi with the test installer'
    _ipi_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-120}
    _run_with_timeout "$_ipi_timeout" env -u SETUP_API_KEY bash "$AGENT_SETUP_TEST_INSTALL_PI_SCRIPT" </dev/null || return 1
  elif [ -n "${AGENT_SETUP_TEST_PI_URL:-}" ]; then
    out_info 'Installing Pi with the test installer download'
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
      out_info 'Installing Pi with npm'
      _pi_legacy_prefix=""
      if [ -n "$PI_BIN" ]; then
        _write_pi_installation_checker || return 1
        _pi_prefix_json=$(node "$SETUP_TMPDIR/pi-installation.mjs" "$PI_BIN" "") || return 1
        _pi_legacy_prefix=$(node -e 'const prefix = JSON.parse(process.argv[1]); if (prefix !== null) process.stdout.write(prefix)' "$_pi_prefix_json") || return 1
      fi
      if [ -n "$_pi_legacy_prefix" ]; then
        _pi_install_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-600}
        _run_with_timeout "$_pi_install_timeout" env -u SETUP_API_KEY npm install --global --prefix "$_pi_legacy_prefix" --force '@earendil-works/pi-coding-agent' </dev/null || return 1
      else
        _install_npm_package '@earendil-works/pi-coding-agent' || return 1
      fi
    else
      out_info 'Installing Pi from pi.dev'
      _download_and_run_installer 'https://pi.dev/install.sh' || return 1
    fi
  fi
  hash -r
  pi_discover_cli
  [ "$DISCOVERED_COUNT" -ge 1 ]
}

pi_write_version() {
  _pv_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-30}
  _pv_version_file="$SETUP_TMPDIR/pi-version.out"
  for _pv_attempt in initial upgraded; do
    if _run_with_timeout "$_pv_timeout" "$PI_BIN" --version > "$_pv_version_file" 2>&1; then
      _pv_version=$(cat "$_pv_version_file")
      out_info "Pi version: $_pv_version"
    else
      _pv_version_status=$?
      if [ "$_pv_version_status" -eq 124 ]; then
        out_error '`pi --version` timed out.'
      else
        out_error '`pi --version` failed.'
      fi
      return 1
    fi
    _pv_status=0
    node -e 'const v = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(process.argv[1].trim()); process.exit(!v ? 2 : (Number(v[1]) > 1 || (Number(v[1]) === 1 && (Number(v[2]) > 1 || (Number(v[2]) === 1 && (Number(v[3]) > 0 || !v[4]))))) ? 0 : 1)' "$_pv_version" || _pv_status=$?
    case "$_pv_status" in
      0) return 0 ;;
      2) out_error 'Pi returned an invalid version.'; return 1 ;;
    esac
    if [ "$_pv_attempt" = upgraded ]; then
      out_error 'Pi upgrade did not provide the required version >= 1.1.0.'
      return 1
    fi
    out_info 'Updating Pi for the Floway provider extension'
    # Self-update preserves the owning package manager or managed installation.
    # https://github.com/earendil-works/pi/blob/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d/packages/coding-agent/src/package-manager-cli.ts#L1048-L1106
    _pv_help_file="$SETUP_TMPDIR/pi-update-help.out"
    if ! _run_with_timeout "$_pv_timeout" "$PI_BIN" update --help > "$_pv_help_file" 2>&1; then
      cat "$_pv_help_file" >&2
      out_error '`pi update --help` failed.'
      return 1
    fi
    if node -e 'process.exit(require("fs").readFileSync(process.argv[1], "utf8").includes("--self") ? 0 : 1)' "$_pv_help_file"; then
      _pv_update_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-120}
      _run_with_timeout "$_pv_update_timeout" env -u SETUP_API_KEY "$PI_BIN" update --self </dev/null || return 1
      hash -r
      pi_discover_cli
    else
      pi_install || return 1
    fi
    if [ "$DISCOVERED_COUNT" -lt 1 ]; then
      out_error 'Pi CLI is unavailable after upgrading.'
      return 1
    fi
  done
}

pi_resolve_agent_dir() {
  PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
  PI_EXTENSION_PATH="$PI_AGENT_DIR/extensions/floway.js"
  PI_SETTINGS_PATH="$PI_AGENT_DIR/settings.json"
  return 0
}

pi_backup_files() {
  PI_EXTENSION_EXISTED=0
  PI_SETTINGS_EXISTED=0
  PI_EXTENSION_BACKUP=""
  PI_SETTINGS_BACKUP=""
  _pbf_stamp=$(date +%Y%m%d%H%M%S).$$
  if [ -e "$PI_EXTENSION_PATH" ]; then
    PI_EXTENSION_EXISTED=1
    PI_EXTENSION_BACKUP="$PI_EXTENSION_PATH.floway-backup.$_pbf_stamp"
    if ! cp "$PI_EXTENSION_PATH" "$PI_EXTENSION_BACKUP"; then
      out_error "could not back up $PI_EXTENSION_PATH"
      return 1
    fi
    if ! chmod 600 "$PI_EXTENSION_BACKUP"; then
      rm -f "$PI_EXTENSION_BACKUP"
      PI_EXTENSION_BACKUP=""
      out_error "could not protect the backup of $PI_EXTENSION_PATH"
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
    "$PI_EXTENSION_EXISTED" "$PI_EXTENSION_BACKUP" "$PI_EXTENSION_PATH" \
    "extension file" "Pi extension" || _prb_rc=1
  _restore_managed_file \
    "$PI_SETTINGS_EXISTED" "$PI_SETTINGS_BACKUP" "$PI_SETTINGS_PATH" \
    "settings file" "Pi settings configuration" || _prb_rc=1
  if [ -n "${PI_EXTENSION_STAGE:-}" ]; then
    rm -f "$PI_EXTENSION_STAGE"
    PI_EXTENSION_STAGE=""
  fi
  if [ -n "${PI_SETTINGS_STAGE:-}" ]; then
    rm -f "$PI_SETTINGS_STAGE"
    PI_SETTINGS_STAGE=""
  fi
  return "$_prb_rc"
}

pi_cleanup_backups() {
  if [ -n "$PI_EXTENSION_BACKUP" ]; then
    _prune_managed_backups "$PI_EXTENSION_PATH" "$PI_EXTENSION_BACKUP" || return 1
    if ! rm -f "$PI_EXTENSION_BACKUP"; then
      out_error "could not remove extension backup $PI_EXTENSION_BACKUP"
      return 1
    fi
    PI_EXTENSION_BACKUP=""
  else
    _prune_managed_backups "$PI_EXTENSION_PATH" "" || return 1
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

pi_fetch_extension() {
  PI_EXTENSION_STAGE="$PI_EXTENSION_PATH.floway-stage.$$"
  : > "$PI_EXTENSION_STAGE" || return 1
  chmod 600 "$PI_EXTENSION_STAGE" || return 1
  _pfe_url="${AGENT_SETUP_TEST_PI_EXTENSION_URL:-${SETUP_ENDPOINT%/}${SETUP_EXTENSION_PATH}}"
  if ! curl -fsSL --connect-timeout 10 --max-time 60 --get --data-urlencode "endpoint=$SETUP_ENDPOINT" --data-urlencode "provider=$SETUP_PI_PROVIDER" -o "$PI_EXTENSION_STAGE" "$_pfe_url"; then
    out_error 'failed to fetch the Floway Pi extension'
    return 1
  fi
  IFS= read -r _pi_stage_marker < "$PI_EXTENSION_STAGE" || true
  if [ "$_pi_stage_marker" != '// Managed by Floway Agent Setup.' ]; then
    out_error 'the Pi extension download has an invalid ownership marker'
    return 1
  fi
  _merge_provider_extension "$PI_EXTENSION_PATH" "$PI_EXTENSION_STAGE"
}

pi_stage_settings() {
  if [ -z "$SETUP_PI_MODEL" ] && [ -z "$SETUP_PI_THINKING_LEVEL" ] && [ -z "$SETUP_PI_RETRY_ENABLED" ] && [ -z "$SETUP_PI_MAX_RETRIES" ] && [ ! -f "$PI_SETTINGS_PATH" ]; then
    PI_SETTINGS_STAGE=""
    return 0
  fi

  PI_SETTINGS_STAGE="$PI_SETTINGS_PATH.floway-stage.$$"
  _pss_err="$SETUP_TMPDIR/settings-edit.err"

  _write_jsonc_editor || return 1
  local _pss_rc=0

  _pss_node_cmd=(
    env "FLOWAY_DEFAULT_PROVIDER=$SETUP_PI_PROVIDER" "FLOWAY_DEFAULT_MODEL=$SETUP_PI_MODEL"
    "FLOWAY_PI_THINKING_LEVEL=$SETUP_PI_THINKING_LEVEL" "FLOWAY_PI_RETRY_ENABLED=$SETUP_PI_RETRY_ENABLED" "FLOWAY_PI_MAX_RETRIES=$SETUP_PI_MAX_RETRIES"
    node "$SETUP_TMPDIR/jsonc-edit.mjs"
  )

  if [ -f "$PI_SETTINGS_PATH" ]; then
    "${_pss_node_cmd[@]}" < "$PI_SETTINGS_PATH" > "$PI_SETTINGS_STAGE" 2> "$_pss_err" || _pss_rc=$?
  else
    "${_pss_node_cmd[@]}" < /dev/null > "$PI_SETTINGS_STAGE" 2> "$_pss_err" || _pss_rc=$?
  fi

  if [ "$_pss_rc" -ne 0 ]; then
    _pss_msg=$(cat "$_pss_err" 2>/dev/null || true)
    out_error "failed to update $PI_SETTINGS_PATH: ${_pss_msg:-unknown error}"
    rm -f "$PI_SETTINGS_STAGE" "$_pss_err"
    PI_SETTINGS_STAGE=""
    return 1
  fi
  rm -f "$_pss_err"

  if ! chmod 600 "$PI_SETTINGS_STAGE"; then
    out_error "could not protect staged settings configuration $PI_SETTINGS_STAGE"
    rm -f "$PI_SETTINGS_STAGE"
    PI_SETTINGS_STAGE=""
    return 1
  fi
  return 0
}

pi_apply_staged() {
  if ! mv "$PI_EXTENSION_STAGE" "$PI_EXTENSION_PATH"; then
    out_error "could not replace $PI_EXTENSION_PATH"
    rm -f "$PI_EXTENSION_STAGE"
    return 1
  fi
  PI_EXTENSION_STAGE=""

  if [ -n "$PI_SETTINGS_STAGE" ]; then
    if ! mv "$PI_SETTINGS_STAGE" "$PI_SETTINGS_PATH"; then
      out_error "could not replace $PI_SETTINGS_PATH"
      rm -f "$PI_SETTINGS_STAGE"
      return 1
    fi
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
  pi_resolve_agent_dir
  if ! mkdir -p "$PI_AGENT_DIR/extensions"; then
    out_error "could not create $PI_AGENT_DIR"
    return 1
  fi

  if [ -e "$PI_EXTENSION_PATH" ]; then
    IFS= read -r _pi_existing_marker < "$PI_EXTENSION_PATH" || true
    if [ "$_pi_existing_marker" != '// Managed by Floway Agent Setup.' ]; then
      out_error 'an unmanaged floway.js extension already exists; move it before running setup.'
      return 1
    fi
  fi

  if ! pi_backup_files; then
    return 1
  fi

  if ! pi_fetch_extension; then
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

  pi_cleanup_backups || return 1

  out_info "Written to \`$PI_EXTENSION_PATH\`."
  if [ -e "$PI_SETTINGS_PATH" ]; then
    out_info "Written to \`$PI_SETTINGS_PATH\`."
  fi
  out_info 'The Floway extension refreshes available models when Pi starts and when the model picker opens.'
  out_agent_notice 'Completed Agent Setup' 'Pi'
}

main 'Pi' "$@"
