# Floway Agent Setup installer (Bash 3.2+). The gateway prepends the
# language-native assignment prefix, so this fixed body has no shebang.
#
# Each served script targets exactly one agent. Errexit stays disabled because
# Bash suppresses it inside guarded calls; failures are checked explicitly and
# the selected agent's configuration is rolled back as one transaction.

# --- output layer -----------------------------------------------------------
#
# Setup-owned output uses plain headings and indented status lines. Native
# package managers inherit the terminal directly, so their ANSI colors,
# carriage-return progress, buffering, and cursor behavior remain intact.
#
# Color is emitted only for an interactive terminal with NO_COLOR unset, probed
# per stream so a redirected capture on either stdout or stderr stays free of
# escape sequences. Informational, progress, and success lines go to stdout;
# warnings, errors, rollback notices, and captured tool output go to stderr.
_stream_color() {
  [ -z "${NO_COLOR:-}" ] || return 1
  [ -n "${AGENT_SETUP_TEST_FORCE_COLOR:-}" ] && return 0
  [ -t "$1" ]
}
_init_output() {
  if _stream_color 1; then _OUT_COLOR=1; else _OUT_COLOR=0; fi
  if _stream_color 2; then _ERR_COLOR=1; else _ERR_COLOR=0; fi
  _C_CYAN=$'\033[96m'
  _C_DARK_CYAN=$'\033[36m'
  _C_GREEN=$'\033[92m'
  _C_YELLOW=$'\033[93m'
  _C_RED=$'\033[91m'
  _C_GRAY=$'\033[90m'
  _C_RESET=$'\033[0m'
}

# Emit one line to a stream, wrapping it in an ANSI color only when that stream
# opted into color and a non-empty color was given (default-color detail lines
# stay uncolored rather than carrying a bare reset). $1 stream
# (1|2), $2 color, $3 text.
_emit_line() {
  if [ "$1" -eq 1 ]; then
    if [ "$_OUT_COLOR" -eq 1 ] && [ -n "$2" ]; then printf '%s%s%s\n' "$2" "$3" "$_C_RESET"; else printf '%s\n' "$3"; fi
  else
    if [ "$_ERR_COLOR" -eq 1 ] && [ -n "$2" ]; then printf '%s%s%s\n' "$2" "$3" "$_C_RESET" >&2; else printf '%s\n' "$3" >&2; fi
  fi
}

out_title() { _emit_line 1 "$_C_CYAN" 'Floway Agent Setup'; }
out_metadata() { _emit_line 1 '' "$1: $2"; }
out_phase() { printf '\n'; _emit_line 1 "$_C_CYAN" "$1"; }
out_step() { _emit_line 1 "$_C_DARK_CYAN" "  · $1"; }
out_info() { _emit_line 1 '' "  $1"; }
out_success() { _emit_line 1 "$_C_GREEN" "  $1"; }
out_warn() { _emit_line 2 "$_C_YELLOW" "  $1"; }
out_error() { _emit_line 2 "$_C_RED" "  $1"; }
out_fatal() { _emit_line 2 "$_C_RED" "$1"; }

# Re-emit captured non-progress output as a de-emphasized, redacted block.
out_captured() {
  redact_key | while IFS= read -r _oc_line; do
    _emit_line 2 "$_C_GRAY" "    $_oc_line"
  done
}

out_summary_entry() {
  case "$2" in
    configured) _os_color=$_C_GREEN ;;
    failed) _os_color=$_C_RED ;;
    *) _os_color=$_C_GRAY ;;
  esac
  _emit_line 1 "$_os_color" "  $1  [$2]"
}

SETUP_TMPDIR=""
_cleanup() {
  if [ -n "$SETUP_TMPDIR" ]; then
    rm -rf "$SETUP_TMPDIR" 2>/dev/null || true
  fi
}
# EXIT owns cleanup. INT/TERM only translate the signal into the conventional
# exit status (130 = 128+SIGINT, 143 = 128+SIGTERM) and let that exit fire the
# EXIT trap. Cleaning up directly inside the INT/TERM handlers would delete the
# working directory and then let the interrupted script resume into the next
# agent's configuration; exiting instead stops all further agent work.
# Managed-key merge applied to the existing Claude settings document. Only the
# keys the setup owns are touched; every unrelated key and env var is preserved.
# An empty optional value means "remove that managed key". The API key is read
# from the environment (`env.SETUP_API_KEY`) so it stays out of argv.
CLAUDE_MERGE_PROGRAM='
  if type != "object" then error("root is not a JSON object")
  elif (has("env") and ((.env | type) != "object")) then error("env is not a JSON object")
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
'

# --- common helpers ---------------------------------------------------------

# Redact every literal occurrence of the API key from a text stream. The key is
# read from the environment (never argv) and matched with index() so arbitrary
# key characters are treated literally rather than as a regex.
redact_key() {
  SETUP_API_KEY="$SETUP_API_KEY" awk '
    BEGIN { k = ENVIRON["SETUP_API_KEY"]; kl = length(k) }
    {
      if (kl == 0) { print; next }
      line = $0; out = ""
      while ((p = index(line, k)) > 0) {
        out = out substr(line, 1, p - 1) "***"
        line = substr(line, p + kl)
      }
      print out line
    }
  '
}

# Run a command under a wall-clock limit. macOS ships no `timeout`, so the
# Bash-3.2 fallback enables job control for one launch, placing the command and
# all ordinary descendants in a dedicated process group. The watchdog signals
# that group with TERM then KILL, retains its process-group id across root exit,
# and the parent waits for escalation to finish before returning 124.
_run_with_timeout() {
  _rwt_secs=$1
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$_rwt_secs" "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$_rwt_secs" "$@"
    return $?
  fi

  _rwt_marker=$(mktemp "$SETUP_TMPDIR/timeout.XXXXXX") || return 1
  rm -f "$_rwt_marker"
  if [ -n "${AGENT_SETUP_TEST_TRACE_TIMEOUT:-}" ]; then
    printf 'Agent Setup test: timeout fallback: process-tree\n'
  fi
  set -m
  "$@" &
  _rwt_pid=$!
  set +m
  (
    # The watchdog must not retain the installer's stdout/stderr descriptors
    # after its parent shell is killed; otherwise a pipe consumer waits for the
    # orphaned sleep to exit before receiving EOF.
    exec </dev/null >/dev/null 2>&1
    sleep "$_rwt_secs"
    if kill -0 "$_rwt_pid" 2>/dev/null; then
      : > "$_rwt_marker"
      kill -TERM -- "-$_rwt_pid" 2>/dev/null || true
      sleep 1
      kill -KILL -- "-$_rwt_pid" 2>/dev/null || true
    fi
  ) &
  _rwt_watchdog=$!
  wait "$_rwt_pid"
  _rwt_status=$?
  if [ -e "$_rwt_marker" ]; then
    # The timeout path waits through TERM→KILL escalation; the process-group id
    # remains valid even after its original leader exits.
    wait "$_rwt_watchdog" 2>/dev/null || true
    rm -f "$_rwt_marker"
    return 124
  fi
  kill "$_rwt_watchdog" 2>/dev/null || true
  wait "$_rwt_watchdog" 2>/dev/null || true
  rm -f "$_rwt_marker"
  return $_rwt_status
}

# Download the pinned official jq build for this platform into the private
# working directory and verify its hard-coded SHA-256 before use. Fails on an
# unsupported platform, a download error, a missing hashing tool, or a checksum
# mismatch — always before any configuration file is touched.
_bootstrap_jq() {
  _bj_os=$(uname -s)
  _bj_arch=$(uname -m)
  case "$_bj_os" in
    Darwin) _bj_os_part=macos ;;
    Linux) _bj_os_part=linux ;;
    *) out_error "no pinned jq build for OS $_bj_os."; return 1 ;;
  esac
  case "$_bj_arch" in
    x86_64 | amd64) _bj_arch_part=amd64 ;;
    arm64 | aarch64) _bj_arch_part=arm64 ;;
    *) out_error "no pinned jq build for architecture $_bj_arch."; return 1 ;;
  esac
  _bj_asset="jq-$_bj_os_part-$_bj_arch_part"
  # Pinned to jqlang/jq release jq-1.8.2. Each digest was verified against the
  # release sha256sum.txt and the Sigstore build attestation
  # (signer: jqlang/jq .github/workflows/ci.yml@refs/tags/jq-1.8.2).
  # Ref: https://github.com/jqlang/jq/releases/tag/jq-1.8.2
  case "$_bj_asset" in
    jq-macos-amd64) _bj_sha=e94b266e3c26690550006abe63152b782280f4e14374accdf04cbde844f00bc0 ;;
    jq-macos-arm64) _bj_sha=2d75340ba57a4b4b4c8708a21c2dc8e958a48aaa8bba13b27f77f6e4c0eca07e ;;
    jq-linux-amd64) _bj_sha=b1c22172dd303f3be49e935aa56aa48a8b7a46e0bc838b4997d3bb451495870f ;;
    jq-linux-arm64) _bj_sha=8b85c817833814ddca00a144c33705546355afccf0cf39b188f3cdb48b852309 ;;
    *) return 1 ;;
  esac
  _bj_url="https://github.com/jqlang/jq/releases/download/jq-1.8.2/$_bj_asset"
  _bj_dest="$SETUP_TMPDIR/$_bj_asset"
  out_step 'jq not found on PATH; fetching the pinned jq-1.8.2 build'
  if ! curl -fsSL --connect-timeout 10 --max-time 120 -o "$_bj_dest" "$_bj_url"; then
    out_error "failed to download jq from $_bj_url"
    rm -f "$_bj_dest"
    return 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    _bj_actual=$(sha256sum "$_bj_dest" | awk '{ print $1 }')
  elif command -v shasum >/dev/null 2>&1; then
    _bj_actual=$(shasum -a 256 "$_bj_dest" | awk '{ print $1 }')
  elif command -v openssl >/dev/null 2>&1; then
    _bj_actual=$(openssl dgst -sha256 "$_bj_dest" | awk '{ print $NF }')
  else
    _bj_actual=""
  fi
  if [ -z "$_bj_actual" ]; then
    out_error 'no SHA-256 tool available to verify the jq download.'
    rm -f "$_bj_dest"
    return 1
  fi
  if [ "$_bj_actual" != "$_bj_sha" ]; then
    out_error 'jq checksum mismatch; refusing to use the download.'
    rm -f "$_bj_dest"
    return 1
  fi
  if ! chmod 700 "$_bj_dest"; then
    rm -f "$_bj_dest"
    return 1
  fi
  JQ="$_bj_dest"
}

# Resolve a usable jq: prefer PATH, else provision the pinned build. The
# AGENT_SETUP_TEST_NO_JQ_DOWNLOAD hook lets the test harness assert the
# fail-before-mutation path without reaching the network.
ensure_jq() {
  if [ -n "$JQ" ]; then
    return 0
  fi
  if command -v jq >/dev/null 2>&1; then
    JQ=jq
    return 0
  fi
  if [ -n "${AGENT_SETUP_TEST_NO_JQ_DOWNLOAD:-}" ]; then
    return 1
  fi
  _bootstrap_jq
}

# Download an installer to the private working directory, refuse anything that
# is not a shell script (region blocks and captive portals serve HTML in place
# of the real installer), then execute it without sudo.
_download_and_run_installer() {
  _dri_url=$1
  _dri_file=$(mktemp "$SETUP_TMPDIR/install.XXXXXX") || return 1
  if ! curl -fsSL --connect-timeout 10 --max-time 120 -o "$_dri_file" "$_dri_url"; then
    out_error "could not download the installer from $_dri_url"
    rm -f "$_dri_file"
    return 1
  fi
  # Reject common HTML responses while allowing official shell content with or
  # without a shebang (some installer CDNs prepend comments).
  if awk '
      NR <= 20 {
        line = tolower($0)
        if (line ~ /^[[:space:]]*(<!doctype[[:space:]]+html|<html([[:space:]>])|<head([[:space:]>])|<body([[:space:]>]))/) found = 1
      }
      END { exit found ? 0 : 1 }
    ' "$_dri_file"; then
    out_error 'the installer download was HTML, not an executable script (a login or region-block page?).'
    rm -f "$_dri_file"
    return 1
  fi
  if ! awk 'NF { found = 1 } END { exit found ? 0 : 1 }' "$_dri_file"; then
    out_error 'the installer download was empty.'
    rm -f "$_dri_file"
    return 1
  fi
  _dri_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-120}
  _run_with_timeout "$_dri_timeout" env -u SETUP_API_KEY bash "$_dri_file" </dev/null
  _dri_rc=$?
  rm -f "$_dri_file"
  return $_dri_rc
}

_discover_cli() {
  _dc_name=$1
  shift
  DISCOVERED_BIN=$(command -v "$_dc_name" 2>/dev/null || true)
  if [ -n "$DISCOVERED_BIN" ]; then
    DISCOVERED_COUNT=1
  else
    DISCOVERED_COUNT=0
  fi
  for _dc_candidate in "$@"; do
    [ -x "$_dc_candidate" ] || continue
    [ "$_dc_candidate" = "$DISCOVERED_BIN" ] && continue
    DISCOVERED_COUNT=$((DISCOVERED_COUNT + 1))
    if [ -z "$DISCOVERED_BIN" ]; then
      DISCOVERED_BIN=$_dc_candidate
    fi
  done
}

# Rollback retains a backup when restoration fails so manual recovery remains
# possible. Callers keep separate transaction boundaries and aggregate failures.
_restore_managed_file() {
  _rmf_existed=$1
  _rmf_backup=$2
  _rmf_path=$3
  _rmf_original_label=$4
  _rmf_created_label=$5
  if [ "$_rmf_existed" -eq 1 ]; then
    if [ -n "$_rmf_backup" ] && [ -e "$_rmf_backup" ] && ! mv "$_rmf_backup" "$_rmf_path" 2>/dev/null; then
      out_warn "could not restore $_rmf_path from its backup; your original $_rmf_original_label is preserved at $_rmf_backup — restore it by hand."
      return 1
    fi
  elif ! rm -f "$_rmf_path" 2>/dev/null; then
    out_warn "could not remove the $_rmf_created_label this run created at $_rmf_path — remove it by hand."
    return 1
  fi
  return 0
}

# --- Claude Code ------------------------------------------------------------

_install_brew_cask() {
  _ibc_cask=$1
  if ! command -v brew >/dev/null 2>&1; then
    out_error 'Homebrew is required to install agent CLIs on macOS.'
    return 1
  fi
  _ibc_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-600}
  _run_with_timeout "$_ibc_timeout" env -u SETUP_API_KEY brew install --cask "$_ibc_cask" </dev/null
}

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
    return 0
  fi

  if [ -n "${AGENT_SETUP_TEST_INSTALL_CLAUDE_SCRIPT:-}" ]; then
    out_step 'Claude Code CLI not found; running the test installer'
    _ic_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-120}
    _run_with_timeout "$_ic_timeout" env -u SETUP_API_KEY bash "$AGENT_SETUP_TEST_INSTALL_CLAUDE_SCRIPT" </dev/null || return 1
  elif [ -n "${AGENT_SETUP_TEST_CLAUDE_URL:-}" ]; then
    out_step 'Claude Code CLI not found; running the test installer download'
    _download_and_run_installer "$AGENT_SETUP_TEST_CLAUDE_URL" || return 1
  else
    case "$(uname -s)" in
      Darwin)
        out_step 'Claude Code CLI not found; installing with Homebrew'
        _install_brew_cask claude-code || return 1
        ;;
      Linux)
        out_step 'Claude Code CLI not found; installing from downloads.claude.ai'
        _download_and_run_installer 'https://downloads.claude.ai/claude-code-releases/bootstrap.sh' || return 1
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

# Surgically merge the managed keys into the Claude settings file: validate the
# existing document, back it up, construct and validate the replacement in the
# same directory, then atomically rename it into place at mode 0600.
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
}

# Confirm the gateway's authenticated model directory answers. No inference
# request is issued. The key is passed through a mode-0600 curl config file so
# it never reaches the process argument list.
claude_check_models() {
  _cm_cfg="$SETUP_TMPDIR/claude-curl.cfg"
  {
    printf 'silent\n'
    printf 'show-error\n'
    printf 'fail\n'
    printf 'header = "anthropic-version: 2023-06-01"\n'
    printf 'header = "Authorization: Bearer %s"\n' "$SETUP_API_KEY"
    printf 'header = "x-api-key: %s"\n' "$SETUP_API_KEY"
  } > "$_cm_cfg"
  chmod 600 "$_cm_cfg" 2>/dev/null || true
  curl -K "$_cm_cfg" --connect-timeout 10 --max-time 30 -o /dev/null "${SETUP_ENDPOINT%/}/v1/models"
  _cm_rc=$?
  rm -f "$_cm_cfg"
  return $_cm_rc
}

# Verify the Claude configuration without inference: reparse the written
# settings, print the raw CLI version, reach the authenticated model directory,
# and run `claude doctor` when the subcommand exists. Doctor output is redacted
# before it is surfaced.
claude_verify() {
  if ! SETUP_API_KEY="$SETUP_API_KEY" "$JQ" -e --arg baseUrl "$SETUP_ENDPOINT" '
      (type == "object")
      and ((.env | type) == "object")
      and (.env.ANTHROPIC_BASE_URL == $baseUrl)
      and (.env.ANTHROPIC_AUTH_TOKEN == env.SETUP_API_KEY)
    ' "$CLAUDE_SETTINGS_PATH" >/dev/null 2>&1; then
    out_error 'the written Claude settings did not reparse as expected.'
    return 1
  fi

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

  if ! claude_check_models; then
    out_error "could not reach the authenticated model directory at ${SETUP_ENDPOINT%/}/v1/models"
    return 1
  fi
  out_success 'reached the authenticated model directory (no inference issued).'

  _cv_doctor_help="$SETUP_TMPDIR/claude-doctor-help.out"
  if _run_with_timeout "$_cv_timeout" "$CLAUDE_BIN" doctor --help </dev/null > "$_cv_doctor_help" 2>&1; then
    if _run_with_timeout "$_cv_timeout" "$CLAUDE_BIN" doctor </dev/null > "$SETUP_TMPDIR/claude-doctor.out" 2>&1; then
      out_success 'claude doctor reported no blocking issues.'
    else
      _cv_doctor_status=$?
      if [ "$_cv_doctor_status" -eq 124 ]; then
        out_error 'claude doctor timed out.'
      else
        out_error 'claude doctor reported a problem:'
        out_captured < "$SETUP_TMPDIR/claude-doctor.out"
      fi
      return 1
    fi
  else
    _cv_help_status=$?
    if [ "$_cv_help_status" -eq 124 ]; then
      out_error 'claude doctor capability check timed out.'
      return 1
    fi
    if grep -Eiq '(unknown|unrecognized|invalid|no such).*(command|subcommand).*doctor|doctor.*(unknown|unrecognized|invalid).*(command|subcommand)' "$_cv_doctor_help"; then
      out_info 'this Claude Code build has no doctor command; skipping that check.'
    else
      out_error 'claude doctor capability check failed:'
      out_captured < "$_cv_doctor_help"
      return 1
    fi
  fi
}

# Configure Claude Code as one transactional unit. jq must resolve before any
# mutation. Verification failure rolls back the settings write; a freshly
# installed CLI is never uninstalled.
configure_claude() {
  out_phase 'Claude Code'
  if ! ensure_jq; then
    out_error 'jq is required to configure Claude Code but is unavailable and could not be provisioned for this platform. Install jq and re-run.'
    return 1
  fi
  if ! claude_ensure_installed; then
    out_error 'Claude Code CLI is unavailable and could not be installed.'
    return 1
  fi
  if ! claude_write_settings; then
    return 1
  fi
  if ! claude_verify; then
    out_warn 'Claude Code verification failed; rolling back settings.'
    claude_rollback_settings
    return 1
  fi
  out_success 'Claude Code configured.'
}

# --- Codex ------------------------------------------------------------------

# Ref: https://github.com/openai/codex/blob/main/scripts/install/install.sh
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
    return 0
  fi

  if [ -n "${AGENT_SETUP_TEST_INSTALL_CODEX_SCRIPT:-}" ]; then
    out_step 'Codex CLI not found; running the test installer'
    _icx_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-120}
    _run_with_timeout "$_icx_timeout" env -u SETUP_API_KEY CODEX_NON_INTERACTIVE=true bash "$AGENT_SETUP_TEST_INSTALL_CODEX_SCRIPT" </dev/null || return 1
  elif [ -n "${AGENT_SETUP_TEST_CODEX_URL:-}" ]; then
    out_step 'Codex CLI not found; running the test installer download'
    CODEX_NON_INTERACTIVE=true _download_and_run_installer "$AGENT_SETUP_TEST_CODEX_URL" || return 1
  else
    case "$(uname -s)" in
      Darwin)
        out_step 'Codex CLI not found; installing with Homebrew'
        _install_brew_cask codex || return 1
        ;;
      Linux)
        # This source is published byte-for-byte as the GitHub release installer.
        # Ref: https://github.com/openai/codex/blob/d3fc1950a920f98e7fa9f11056667cdf911c38df/scripts/install/install.sh
        out_step 'Codex CLI not found; installing from GitHub'
        CODEX_NON_INTERACTIVE=true _download_and_run_installer 'https://raw.githubusercontent.com/openai/codex/refs/heads/main/scripts/install/install.sh' || return 1
        ;;
      *)
        out_error 'automatic Codex installation supports macOS and Linux only in the Bash installer.'
        return 1
        ;;
    esac
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
  _cwc_edits=$("$JQ" -cn \
    --arg base "$_cwc_base" \
    --arg model "$SETUP_CODEX_MODEL" \
    --arg effort "$SETUP_CODEX_REASONING_EFFORT" '
    [
      {keyPath:"model_provider",mergeStrategy:"replace",value:"floway"},
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
    ok)
      out_success 'Codex base configuration written.'
      ;;
    okOverridden)
      _cwc_msg=$(printf '%s' "$_cwc_result" | "$JQ" -r '.result.overriddenMetadata.message // "an override layer applies"' 2>/dev/null)
      _cwc_layer=$(printf '%s' "$_cwc_result" | "$JQ" -r '.result.overriddenMetadata.overridingLayer.name.type // "unknown"' 2>/dev/null)
      out_warn "Codex base configuration written, but a higher-precedence layer overrides it ($_cwc_msg; layer: $_cwc_layer)."
      ;;
    *)
      out_error "the Codex app-server did not confirm the configuration (status: ${_cwc_status:-none})."
      return 1
      ;;
  esac
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

# Confirm the gateway's authenticated Codex model directory answers. No inference
# request is issued. When a model was selected, confirm it is present in the
# returned catalog. The key is passed through a mode-0600 curl config file so it
# never reaches the process argument list.
codex_check_models() {
  _ccm_base="${SETUP_ENDPOINT%/}/azure-api.codex"
  _ccm_cfg="$SETUP_TMPDIR/codex-curl.cfg"
  {
    printf 'silent\n'
    printf 'show-error\n'
    printf 'fail\n'
    printf 'header = "Authorization: Bearer %s"\n' "$SETUP_API_KEY"
  } > "$_ccm_cfg"
  chmod 600 "$_ccm_cfg" 2>/dev/null || true
  _ccm_body="$SETUP_TMPDIR/codex-models.json"
  curl -K "$_ccm_cfg" --connect-timeout 10 --max-time 30 -o "$_ccm_body" "$_ccm_base/models"
  _ccm_rc=$?
  rm -f "$_ccm_cfg"
  if [ "$_ccm_rc" -ne 0 ]; then
    rm -f "$_ccm_body"
    return 1
  fi
  if [ -n "$SETUP_CODEX_MODEL" ]; then
    if ! "$JQ" -e --arg m "$SETUP_CODEX_MODEL" 'any(.models[]?; .slug == $m)' "$_ccm_body" >/dev/null 2>&1; then
      out_error "the selected Codex model $SETUP_CODEX_MODEL is not in the gateway catalog."
      rm -f "$_ccm_body"
      return 1
    fi
  fi
  rm -f "$_ccm_body"
}

# Verify Codex without inference: compare the provider token without printing
# it, print the raw CLI version, and reach the authenticated model directory
# (confirming the selected model when one is set).
codex_verify() {
  if ! cmp -s "$CODEX_TOKEN_PATH" <(printf '%s' "$SETUP_API_KEY"); then
    out_error 'the written Codex provider token did not reparse as expected.'
    return 1
  fi

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

  if ! codex_check_models; then
    out_error "could not reach the authenticated Codex model directory at ${SETUP_ENDPOINT%/}/azure-api.codex/models"
    return 1
  fi
  out_success 'reached the authenticated Codex model directory (no inference issued).'
}

# Configure Codex as one transactional unit. jq must resolve before any
# mutation. The config and provider token are backed up first; a write or
# verification failure restores both (or removes newly created files). A
# freshly installed CLI is never uninstalled.
configure_codex() {
  out_phase 'Codex'
  if ! ensure_jq; then
    out_error 'jq is required to configure Codex but is unavailable and could not be provisioned for this platform. Install jq and re-run.'
    return 1
  fi
  if ! codex_ensure_installed; then
    out_error 'Codex CLI is unavailable and could not be installed.'
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
  if ! codex_verify; then
    out_warn 'Codex verification failed; rolling back configuration and token.'
    codex_rollback
    return 1
  fi
  out_success 'Codex configured.'
}

# --- run --------------------------------------------------------------------

main() {
  set -u
  umask 077
  set -o pipefail 2>/dev/null || true

  # Neutralize identically named exported variables inherited from the caller.
  # jq receives the API key only on the exact invocations that need it; package
  # managers and CLIs never inherit the credential.
  export -n SETUP_API_KEY SETUP_API_KEY_NAME SETUP_AGENT 2>/dev/null || true

  _init_output
  out_title

  if [ -z "${SETUP_ENDPOINT:-}" ]; then
    out_fatal 'SETUP_ENDPOINT must be set to this gateway origin (e.g. https://gateway.example).'
    return 1
  fi
  case "$SETUP_ENDPOINT" in
    http://?* | https://?*) ;;
    *) out_fatal "SETUP_ENDPOINT must be an http(s) origin, got $SETUP_ENDPOINT"; return 1 ;;
  esac
  case "$SETUP_AGENT" in
    claude | codex) ;;
    *) out_fatal "unknown setup agent: $SETUP_AGENT"; return 1 ;;
  esac
  out_metadata 'Endpoint' "$SETUP_ENDPOINT"
  out_metadata 'API Key' "$SETUP_API_KEY_NAME"
  export -n SETUP_ENDPOINT 2>/dev/null || true

  SETUP_TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-setup.XXXXXX") || {
    out_fatal 'could not create a private working directory.'
    return 1
  }
  chmod 700 "$SETUP_TMPDIR" 2>/dev/null || true
  trap _cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  JQ=""

  OVERALL=0
  case "$SETUP_AGENT" in
    claude)
      if configure_claude; then RESULT=configured; else RESULT=failed; OVERALL=1; fi
      out_phase 'Summary'
      out_summary_entry 'Claude Code' "$RESULT"
      ;;
    codex)
      if configure_codex; then RESULT=configured; else RESULT=failed; OVERALL=1; fi
      out_phase 'Summary'
      out_summary_entry 'Codex' "$RESULT"
      ;;
  esac
  return "$OVERALL"
}

main "$@"
