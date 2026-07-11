# Floway agent setup installer (Bash 3.2+).
#
# Fixed, checked-in body. The Bash assignment prefix (the FLOWAY_*
# variables and a trace-suppressing `set +x`) is prepended per request by the
# gateway, so this file starts straight at the installer logic with no shebang.
#
# Claude Code and Codex are configured as independent transactional units: a
# failure in one neither rolls back nor skips the other, and any selected-agent
# failure makes the whole script exit non-zero. Errexit is deliberately NOT set
# — Bash disables it inside the `if agent; then ... fi` guards used for that
# independent aggregation, so control flow relies on explicit checks and
# per-agent rollback instead.

set -u
umask 077
set -o pipefail 2>/dev/null || true

# The API key remains a shell variable, not an exported process-environment
# value. `export -n` also neutralizes an identically named exported variable
# inherited from the caller. jq/awk receive it only on the individual
# invocations that need it; the official installer and Claude CLI never inherit
# it.
export -n FLOWAY_API_KEY 2>/dev/null || true

FLOWAY_SETUP_TMPDIR=""
_cleanup() {
  if [ -n "$FLOWAY_SETUP_TMPDIR" ]; then
    rm -rf "$FLOWAY_SETUP_TMPDIR" 2>/dev/null || true
  fi
}
trap _cleanup EXIT INT TERM

# Resolved lazily by ensure_jq: either `jq` on PATH or a verified pinned build.
JQ=""

# Managed-key merge applied to the existing Claude settings document. Only the
# keys Floway owns are touched; every unrelated key and env var is preserved.
# An empty optional value means "remove that managed key". The API key is read
# from the environment (`env.FLOWAY_API_KEY`) so it stays out of argv.
CLAUDE_MERGE_PROGRAM='
  if type != "object" then error("root is not a JSON object")
  elif (has("env") and ((.env | type) != "object")) then error("env is not a JSON object")
  else . end
  | (if (has("env") | not) then .env = {} else . end)
  | .env.ANTHROPIC_BASE_URL = $baseUrl
  | .env.ANTHROPIC_AUTH_TOKEN = env.FLOWAY_API_KEY
  | (if $model == "" then del(.env.ANTHROPIC_MODEL) else .env.ANTHROPIC_MODEL = $model end)
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
  FLOWAY_API_KEY="$FLOWAY_API_KEY" awk '
    BEGIN { k = ENVIRON["FLOWAY_API_KEY"]; kl = length(k) }
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

# Print the SHA-256 of a file using whatever hashing tool is available; empty
# output signals that none is.
_sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{ print $NF }'
  fi
}

# Run a command under a wall-clock limit. macOS ships no `timeout`, so the
# Bash-3.2 fallback starts a watchdog that records an explicit timeout marker,
# terminates the command, then reaps both processes. All timeout paths return
# 124, distinct from any command-specific failure status.
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

  _rwt_marker=$(mktemp "$FLOWAY_SETUP_TMPDIR/timeout.XXXXXX") || return 1
  rm -f "$_rwt_marker"
  "$@" &
  _rwt_pid=$!
  (
    # The watchdog must not retain the installer's stdout/stderr descriptors
    # after its parent shell is killed; otherwise a pipe consumer waits for the
    # orphaned sleep to exit before receiving EOF.
    exec </dev/null >/dev/null 2>&1
    sleep "$_rwt_secs"
    if kill -0 "$_rwt_pid" 2>/dev/null; then
      : > "$_rwt_marker"
      kill -TERM "$_rwt_pid" 2>/dev/null || true
      sleep 1
      kill -KILL "$_rwt_pid" 2>/dev/null || true
    fi
  ) &
  _rwt_watchdog=$!
  wait "$_rwt_pid"
  _rwt_status=$?
  kill "$_rwt_watchdog" 2>/dev/null || true
  wait "$_rwt_watchdog" 2>/dev/null || true
  if [ -e "$_rwt_marker" ]; then
    rm -f "$_rwt_marker"
    return 124
  fi
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
    *) printf 'Floway: no pinned jq build for OS %s.\n' "$_bj_os" >&2; return 1 ;;
  esac
  case "$_bj_arch" in
    x86_64 | amd64) _bj_arch_part=amd64 ;;
    arm64 | aarch64) _bj_arch_part=arm64 ;;
    *) printf 'Floway: no pinned jq build for architecture %s.\n' "$_bj_arch" >&2; return 1 ;;
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
  _bj_dest="$FLOWAY_SETUP_TMPDIR/$_bj_asset"
  printf 'Floway: jq not found on PATH; fetching the pinned jq-1.8.2 build...\n'
  if ! curl -fsSL --connect-timeout 10 --max-time 120 -o "$_bj_dest" "$_bj_url"; then
    printf 'Floway: failed to download jq from %s\n' "$_bj_url" >&2
    rm -f "$_bj_dest"
    return 1
  fi
  _bj_actual=$(_sha256_of "$_bj_dest")
  if [ -z "$_bj_actual" ]; then
    printf 'Floway: no SHA-256 tool available to verify the jq download.\n' >&2
    rm -f "$_bj_dest"
    return 1
  fi
  if [ "$_bj_actual" != "$_bj_sha" ]; then
    printf 'Floway: jq checksum mismatch; refusing to use the download.\n' >&2
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
# FLOWAY_INSTALLER_TEST_NO_JQ_DOWNLOAD hook lets the test harness assert the
# fail-before-mutation path without reaching the network.
ensure_jq() {
  if [ -n "$JQ" ]; then
    return 0
  fi
  if command -v jq >/dev/null 2>&1; then
    JQ=jq
    return 0
  fi
  if [ -n "${FLOWAY_INSTALLER_TEST_NO_JQ_DOWNLOAD:-}" ]; then
    return 1
  fi
  _bootstrap_jq
}

# Download an installer to the private working directory, refuse anything that
# is not a shell script (region blocks and captive portals serve HTML in place
# of the real installer), then execute it without sudo.
_download_and_run_installer() {
  _dri_url=$1
  _dri_file=$(mktemp "$FLOWAY_SETUP_TMPDIR/install.XXXXXX") || return 1
  if ! curl -fsSL --connect-timeout 10 --max-time 120 -o "$_dri_file" "$_dri_url"; then
    printf 'Floway: could not download the installer from %s\n' "$_dri_url" >&2
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
    printf 'Floway: the installer download was HTML, not an executable script (a login or region-block page?).\n' >&2
    rm -f "$_dri_file"
    return 1
  fi
  if ! awk 'NF { found = 1 } END { exit found ? 0 : 1 }' "$_dri_file"; then
    printf 'Floway: the installer download was empty.\n' >&2
    rm -f "$_dri_file"
    return 1
  fi
  _dri_timeout=${FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS:-120}
  _run_with_timeout "$_dri_timeout" env -u FLOWAY_API_KEY bash "$_dri_file"
  _dri_rc=$?
  rm -f "$_dri_file"
  return $_dri_rc
}

# --- Claude Code ------------------------------------------------------------

# Resolve the Claude Code executable. The PATH winner is authoritative; known
# official user-local locations are also consulted so an install that is not on
# PATH is still found, and so multiple installations can be flagged.
# Ref: https://docs.claude.com/en/docs/claude-code/troubleshoot-install
claude_discover() {
  CLAUDE_BIN=""
  CLAUDE_INSTALL_COUNT=0
  _cd_path=$(command -v claude 2>/dev/null || true)
  if [ -n "$_cd_path" ]; then
    CLAUDE_BIN="$_cd_path"
    CLAUDE_INSTALL_COUNT=1
  fi
  for _cd_cand in \
    "$HOME/.local/bin/claude" \
    "$HOME/.claude/local/claude" \
    "$HOME/.bun/bin/claude" \
    "/opt/homebrew/bin/claude" \
    "/usr/local/bin/claude"; do
    [ -x "$_cd_cand" ] || continue
    [ "$_cd_cand" = "$_cd_path" ] && continue
    CLAUDE_INSTALL_COUNT=$((CLAUDE_INSTALL_COUNT + 1))
    if [ -z "$CLAUDE_BIN" ]; then
      CLAUDE_BIN="$_cd_cand"
    fi
  done
}

# Install the official user-local Claude Code build. The
# FLOWAY_INSTALLER_TEST_INSTALL_CLAUDE_SCRIPT hook — read from the ambient
# environment, never emitted by the gateway — substitutes a fake installer
# under test.
install_claude() {
  if [ -n "${FLOWAY_INSTALLER_TEST_INSTALL_CLAUDE_SCRIPT:-}" ]; then
    _ic_timeout=${FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS:-120}
    _run_with_timeout "$_ic_timeout" env -u FLOWAY_API_KEY bash "$FLOWAY_INSTALLER_TEST_INSTALL_CLAUDE_SCRIPT"
    return $?
  fi
  # Ref: https://docs.claude.com/en/docs/claude-code/setup ("Native Install").
  _download_and_run_installer "${FLOWAY_INSTALLER_TEST_CLAUDE_URL:-https://claude.ai/install.sh}"
}

# Ensure Claude Code is present, installing it only when absent. An existing
# install is never upgraded or compatibility-checked.
claude_ensure_installed() {
  claude_discover
  if [ "$CLAUDE_INSTALL_COUNT" -gt 1 ]; then
    printf 'Floway: multiple Claude Code installations detected; using %s.\n' "$CLAUDE_BIN" >&2
  fi
  if [ "$CLAUDE_INSTALL_COUNT" -ge 1 ]; then
    return 0
  fi
  printf 'Floway: Claude Code CLI not found; installing the official user-local build...\n'
  if ! install_claude; then
    return 1
  fi
  hash -r 2>/dev/null || true
  claude_discover
  [ "$CLAUDE_INSTALL_COUNT" -ge 1 ]
}

# Restore the settings file to its pre-run state: replace it from the backup
# when one exists, or remove the file entirely when this run created it.
claude_rollback_settings() {
  if [ "${CLAUDE_SETTINGS_EXISTED:-0}" -eq 1 ]; then
    if [ -n "${CLAUDE_SETTINGS_BACKUP:-}" ] && [ -e "$CLAUDE_SETTINGS_BACKUP" ]; then
      mv "$CLAUDE_SETTINGS_BACKUP" "$CLAUDE_SETTINGS_PATH" 2>/dev/null || true
    fi
  else
    rm -f "$CLAUDE_SETTINGS_PATH" 2>/dev/null || true
  fi
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
    printf 'Floway: could not create %s\n' "$_cw_dir" >&2
    return 1
  fi

  if [ -e "$CLAUDE_SETTINGS_PATH" ]; then
    CLAUDE_SETTINGS_EXISTED=1
    if ! "$JQ" '
        if type != "object" then error("root is not a JSON object")
        elif (has("env") and ((.env | type) != "object")) then error("env is not a JSON object")
        else . end
      ' "$CLAUDE_SETTINGS_PATH" >/dev/null 2>&1; then
      printf 'Floway: %s is not valid Claude settings; leaving it untouched.\n' "$CLAUDE_SETTINGS_PATH" >&2
      return 1
    fi
    _cw_base=$(cat "$CLAUDE_SETTINGS_PATH")
    CLAUDE_SETTINGS_BACKUP="$CLAUDE_SETTINGS_PATH.floway-backup.$(date +%Y%m%d%H%M%S).$$"
    if ! cp "$CLAUDE_SETTINGS_PATH" "$CLAUDE_SETTINGS_BACKUP"; then
      printf 'Floway: could not back up %s\n' "$CLAUDE_SETTINGS_PATH" >&2
      return 1
    fi
  else
    _cw_base='{}'
  fi

  _cw_stage="$CLAUDE_SETTINGS_PATH.floway-stage.$$"
  if ! printf '%s' "$_cw_base" | FLOWAY_API_KEY="$FLOWAY_API_KEY" "$JQ" \
      --arg baseUrl "$FLOWAY_BASE_URL" \
      --arg model "$FLOWAY_CLAUDE_MODEL" \
      --arg sonnet "$FLOWAY_CLAUDE_DEFAULT_SONNET_MODEL" \
      --arg haiku "$FLOWAY_CLAUDE_DEFAULT_HAIKU_MODEL" \
      --arg discovery "$FLOWAY_CLAUDE_MODEL_DISCOVERY" \
      --arg effort "$FLOWAY_CLAUDE_EFFORT_LEVEL" \
      "$CLAUDE_MERGE_PROGRAM" > "$_cw_stage"; then
    printf 'Floway: failed to construct updated Claude settings.\n' >&2
    rm -f "$_cw_stage"
    claude_rollback_settings
    return 1
  fi

  if ! FLOWAY_API_KEY="$FLOWAY_API_KEY" "$JQ" -e --arg baseUrl "$FLOWAY_BASE_URL" '
      (type == "object")
      and ((.env | type) == "object")
      and (.env.ANTHROPIC_BASE_URL == $baseUrl)
      and (.env.ANTHROPIC_AUTH_TOKEN == env.FLOWAY_API_KEY)
    ' "$_cw_stage" >/dev/null 2>&1; then
    printf 'Floway: staged Claude settings failed validation.\n' >&2
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
    printf 'Floway: could not replace %s\n' "$CLAUDE_SETTINGS_PATH" >&2
    rm -f "$_cw_stage"
    claude_rollback_settings
    return 1
  fi
}

# Confirm the gateway's authenticated model directory answers. No inference
# request is issued. The key is passed through a mode-0600 curl config file so
# it never reaches the process argument list.
claude_check_models() {
  _cm_cfg="$FLOWAY_SETUP_TMPDIR/claude-curl.cfg"
  {
    printf 'silent\n'
    printf 'show-error\n'
    printf 'fail\n'
    printf 'header = "anthropic-version: 2023-06-01"\n'
    printf 'header = "Authorization: Bearer %s"\n' "$FLOWAY_API_KEY"
    printf 'header = "x-api-key: %s"\n' "$FLOWAY_API_KEY"
  } > "$_cm_cfg"
  chmod 600 "$_cm_cfg" 2>/dev/null || true
  curl -K "$_cm_cfg" --connect-timeout 10 --max-time 30 -o /dev/null "${FLOWAY_BASE_URL%/}/v1/models"
  _cm_rc=$?
  rm -f "$_cm_cfg"
  return $_cm_rc
}

# Verify the Claude configuration without inference: reparse the written
# settings, print the raw CLI version, reach the authenticated model directory,
# and run `claude doctor` when the subcommand exists. Doctor output is redacted
# before it is surfaced.
claude_verify() {
  if ! FLOWAY_API_KEY="$FLOWAY_API_KEY" "$JQ" -e --arg baseUrl "$FLOWAY_BASE_URL" '
      (type == "object")
      and ((.env | type) == "object")
      and (.env.ANTHROPIC_BASE_URL == $baseUrl)
      and (.env.ANTHROPIC_AUTH_TOKEN == env.FLOWAY_API_KEY)
    ' "$CLAUDE_SETTINGS_PATH" >/dev/null 2>&1; then
    printf 'Floway: the written Claude settings did not reparse as expected.\n' >&2
    return 1
  fi

  _cv_timeout=${FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS:-30}
  _cv_version_file="$FLOWAY_SETUP_TMPDIR/claude-version.out"
  if _run_with_timeout "$_cv_timeout" "$CLAUDE_BIN" --version > "$_cv_version_file" 2>&1; then
    _cv_version=$(cat "$_cv_version_file")
  else
    _cv_version_status=$?
    if [ "$_cv_version_status" -eq 124 ]; then
      printf 'Floway: `claude --version` timed out.\n' >&2
    else
      printf 'Floway: `claude --version` failed.\n' >&2
    fi
    return 1
  fi
  printf 'Floway: Claude Code version: %s\n' "$_cv_version"

  if ! claude_check_models; then
    printf 'Floway: could not reach the authenticated model directory at %s/v1/models\n' "${FLOWAY_BASE_URL%/}" >&2
    return 1
  fi
  printf 'Floway: reached the authenticated model directory (no inference issued).\n'

  _cv_doctor_help="$FLOWAY_SETUP_TMPDIR/claude-doctor-help.out"
  if _run_with_timeout "$_cv_timeout" "$CLAUDE_BIN" doctor --help </dev/null > "$_cv_doctor_help" 2>&1; then
    if _run_with_timeout "$_cv_timeout" "$CLAUDE_BIN" doctor </dev/null > "$FLOWAY_SETUP_TMPDIR/claude-doctor.out" 2>&1; then
      printf 'Floway: claude doctor reported no blocking issues.\n'
    else
      _cv_doctor_status=$?
      if [ "$_cv_doctor_status" -eq 124 ]; then
        printf 'Floway: claude doctor timed out.\n' >&2
      else
        printf 'Floway: claude doctor reported a problem:\n' >&2
        redact_key < "$FLOWAY_SETUP_TMPDIR/claude-doctor.out" >&2
      fi
      return 1
    fi
  else
    _cv_help_status=$?
    if [ "$_cv_help_status" -eq 124 ]; then
      printf 'Floway: claude doctor capability check timed out.\n' >&2
      return 1
    fi
    if grep -Eiq 'unknown (command|argument)|unrecognized (command|argument)|no such command|invalid (command|argument)' "$_cv_doctor_help"; then
      printf 'Floway: this Claude Code build has no doctor command; skipping that check.\n'
    else
      printf 'Floway: claude doctor capability check failed.\n' >&2
      redact_key < "$_cv_doctor_help" >&2
      return 1
    fi
  fi
}

# Configure Claude Code as one transactional unit. jq must resolve before any
# mutation. Verification failure rolls back the settings write; a freshly
# installed CLI is never uninstalled.
configure_claude() {
  printf 'Floway: configuring Claude Code...\n'
  if ! ensure_jq; then
    printf 'Floway: jq is required to configure Claude Code but is unavailable and could not be provisioned for this platform. Install jq and re-run.\n' >&2
    return 1
  fi
  if ! claude_ensure_installed; then
    printf 'Floway: Claude Code CLI is unavailable and could not be installed.\n' >&2
    return 1
  fi
  if ! claude_write_settings; then
    return 1
  fi
  if ! claude_verify; then
    printf 'Floway: Claude Code verification failed; rolling back settings.\n' >&2
    claude_rollback_settings
    return 1
  fi
  printf 'Floway: Claude Code configured.\n'
}

# --- Codex ------------------------------------------------------------------

# Codex configuration is implemented in the next task. Reporting failure keeps a
# selected-but-unconfigured Codex from being summarized as done.
configure_codex() {
  printf 'Floway: Codex configuration is not implemented in this build yet.\n' >&2
  return 1
}

# --- run --------------------------------------------------------------------

FLOWAY_SETUP_TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/floway-setup.XXXXXX") || {
  printf 'Floway: could not create a private working directory.\n' >&2
  exit 1
}
chmod 700 "$FLOWAY_SETUP_TMPDIR" 2>/dev/null || true

CLAUDE_RESULT=skipped
CODEX_RESULT=skipped
OVERALL=0

if [ -n "$FLOWAY_INSTALL_CLAUDE" ]; then
  if configure_claude; then
    CLAUDE_RESULT=configured
  else
    CLAUDE_RESULT=failed
    OVERALL=1
  fi
fi

if [ -n "$FLOWAY_INSTALL_CODEX" ]; then
  if configure_codex; then
    CODEX_RESULT=configured
  else
    CODEX_RESULT=failed
    OVERALL=1
  fi
fi

printf '\nFloway agent setup summary:\n'
printf '  Claude Code: %s\n' "$CLAUDE_RESULT"
printf '  Codex:       %s\n' "$CODEX_RESULT"

exit "$OVERALL"
