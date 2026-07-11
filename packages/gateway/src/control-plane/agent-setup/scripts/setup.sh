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

# FLOWAY_BASE_URL is supplied by the wrapping one-line command's environment
# (`export FLOWAY_BASE_URL='<origin>'; curl ... | bash`), never baked into this
# body — the gateway that served this script never learns its own public origin.
# Require a non-empty http(s) origin before any configuration is touched; a bare
# `set -u` reference would otherwise abort later with an opaque "unbound
# variable". Then `export -n` demotes it to a plain shell variable so the
# official installers and the agent CLIs do not inherit it, exactly as the API
# key is handled.
if [ -z "${FLOWAY_BASE_URL:-}" ]; then
  printf 'Floway: FLOWAY_BASE_URL must be set to this gateway origin (e.g. https://gateway.example).\n' >&2
  exit 1
fi
case "$FLOWAY_BASE_URL" in
  http://?* | https://?*) ;;
  *)
    printf 'Floway: FLOWAY_BASE_URL must be an http(s) origin, got %s\n' "$FLOWAY_BASE_URL" >&2
    exit 1
    ;;
esac
export -n FLOWAY_BASE_URL 2>/dev/null || true

FLOWAY_SETUP_TMPDIR=""
_cleanup() {
  if [ -n "$FLOWAY_SETUP_TMPDIR" ]; then
    rm -rf "$FLOWAY_SETUP_TMPDIR" 2>/dev/null || true
  fi
}
# EXIT owns cleanup. INT/TERM only translate the signal into the conventional
# exit status (130 = 128+SIGINT, 143 = 128+SIGTERM) and let that exit fire the
# EXIT trap. Cleaning up directly inside the INT/TERM handlers would delete the
# working directory and then let the interrupted script resume into the next
# agent's configuration; exiting instead stops all further agent work.
trap _cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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

  _rwt_marker=$(mktemp "$FLOWAY_SETUP_TMPDIR/timeout.XXXXXX") || return 1
  rm -f "$_rwt_marker"
  if [ -n "${FLOWAY_INSTALLER_TEST_TRACE_TIMEOUT:-}" ]; then
    printf 'Floway test: timeout fallback: process-tree\n'
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
# when one exists, or remove the file entirely when this run created it. A
# restoration that itself fails is never masked — the backup is left untouched
# and a prominent, path-specific message tells the operator how to recover by
# hand. Returns non-zero on such a failure so the caller can aggregate it.
claude_rollback_settings() {
  if [ "${CLAUDE_SETTINGS_EXISTED:-0}" -eq 1 ]; then
    if [ -n "${CLAUDE_SETTINGS_BACKUP:-}" ] && [ -e "$CLAUDE_SETTINGS_BACKUP" ]; then
      if ! mv "$CLAUDE_SETTINGS_BACKUP" "$CLAUDE_SETTINGS_PATH" 2>/dev/null; then
        printf 'Floway: WARNING could not restore %s from its backup; your original file is preserved at %s — restore it by hand.\n' \
          "$CLAUDE_SETTINGS_PATH" "$CLAUDE_SETTINGS_BACKUP" >&2
        return 1
      fi
    fi
  elif ! rm -f "$CLAUDE_SETTINGS_PATH" 2>/dev/null; then
    printf 'Floway: WARNING could not remove the Claude settings this run created at %s — remove it by hand.\n' \
      "$CLAUDE_SETTINGS_PATH" >&2
    return 1
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
    if grep -Eiq '(unknown|unrecognized|invalid|no such).*(command|subcommand).*doctor|doctor.*(unknown|unrecognized|invalid).*(command|subcommand)' "$_cv_doctor_help"; then
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

# The refresh_token slot is a fixed non-secret placeholder: the gateway
# authenticates the data plane with the API key carried as access_token and
# never rotates a ChatGPT refresh token, so a real refresh value would be
# meaningless. Codex only reads it back; it is never sent upstream.
CODEX_REFRESH_NOOP="floway-managed-no-refresh"

# Build Floway's placeholder ChatGPT identity token from the gateway origin and
# expose it as FLOWAY_CODEX_ID_TOKEN. Codex decodes this alg=none JWT to render
# `codex login status`; it is never verified because the gateway authenticates
# the data plane with the API key carried as access_token, not with this token.
# The host-derived email keeps multiple deployments distinguishable in the CLI's
# status output. Assembled here — not by the gateway — so the server never learns
# its own public origin: jq's @base64 is post-processed into unpadded base64url.
# Ref: packages/provider-codex/src/auth/jwt.ts (the decode-only claim reader).
codex_build_id_token() {
  _cbit_host="${FLOWAY_BASE_URL#*://}"
  _cbit_host="${_cbit_host%%/*}"
  FLOWAY_CODEX_ID_TOKEN=$("$JQ" -rn --arg host "$_cbit_host" '
    def b64url: @base64 | gsub("=";"") | gsub("\\+";"-") | gsub("/";"_");
    ({alg:"none",typ:"JWT"} | tojson | b64url) as $header
    | ({email: ("floway@" + $host), "https://api.openai.com/auth": {chatgpt_plan_type:"pro_plus", chatgpt_user_id:"user-floway", chatgpt_account_id:"acct-floway"}} | tojson | b64url) as $payload
    | $header + "." + $payload + ".c2ln"
  ') || {
    printf 'Floway: could not construct the Codex identity token.\n' >&2
    return 1
  }
}

# Resolve the Codex executable. The PATH winner is authoritative; known official
# user-local locations are also consulted so an install that is not on PATH is
# still found, and so multiple installations can be flagged.
# Ref: https://github.com/openai/codex/blob/main/scripts/install/install.sh
codex_discover() {
  CODEX_BIN=""
  CODEX_INSTALL_COUNT=0
  _cxd_path=$(command -v codex 2>/dev/null || true)
  if [ -n "$_cxd_path" ]; then
    CODEX_BIN="$_cxd_path"
    CODEX_INSTALL_COUNT=1
  fi
  for _cxd_cand in \
    "$HOME/.local/bin/codex" \
    "/opt/homebrew/bin/codex" \
    "/usr/local/bin/codex"; do
    [ -x "$_cxd_cand" ] || continue
    [ "$_cxd_cand" = "$_cxd_path" ] && continue
    CODEX_INSTALL_COUNT=$((CODEX_INSTALL_COUNT + 1))
    if [ -z "$CODEX_BIN" ]; then
      CODEX_BIN="$_cxd_cand"
    fi
  done
}

# Install the official user-local Codex build. CODEX_NON_INTERACTIVE keeps the
# installer from prompting. The FLOWAY_INSTALLER_TEST_INSTALL_CODEX_SCRIPT hook —
# read from the ambient environment, never emitted by the gateway — substitutes
# a fake installer under test.
install_codex() {
  if [ -n "${FLOWAY_INSTALLER_TEST_INSTALL_CODEX_SCRIPT:-}" ]; then
    _icx_timeout=${FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS:-120}
    _run_with_timeout "$_icx_timeout" env -u FLOWAY_API_KEY CODEX_NON_INTERACTIVE=true bash "$FLOWAY_INSTALLER_TEST_INSTALL_CODEX_SCRIPT"
    return $?
  fi
  # Ref: https://github.com/openai/codex README ("curl -fsSL https://chatgpt.com/codex/install.sh | sh").
  CODEX_NON_INTERACTIVE=true _download_and_run_installer "${FLOWAY_INSTALLER_TEST_CODEX_URL:-https://chatgpt.com/codex/install.sh}"
}

# Ensure Codex is present, installing it only when absent. An existing install
# is never upgraded or compatibility-checked.
codex_ensure_installed() {
  codex_discover
  if [ "$CODEX_INSTALL_COUNT" -gt 1 ]; then
    printf 'Floway: multiple Codex installations detected; using %s.\n' "$CODEX_BIN" >&2
  fi
  if [ "$CODEX_INSTALL_COUNT" -ge 1 ]; then
    return 0
  fi
  printf 'Floway: Codex CLI not found; installing the official user-local build...\n'
  if ! install_codex; then
    return 1
  fi
  hash -r 2>/dev/null || true
  codex_discover
  [ "$CODEX_INSTALL_COUNT" -ge 1 ]
}

# Resolve the Codex home and the two managed files. Codex reads CODEX_HOME the
# same way, so the app-server writes config.toml at exactly this location.
codex_resolve_home() {
  CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
  CODEX_CONFIG_PATH="$CODEX_HOME_DIR/config.toml"
  CODEX_AUTH_PATH="$CODEX_HOME_DIR/auth.json"
}

# Back up both managed files before any mutation, recording the absence of each
# so rollback can distinguish "restore" from "remove". Fails before mutation if
# a backup copy cannot be made.
codex_backup_files() {
  CODEX_CONFIG_EXISTED=0
  CODEX_AUTH_EXISTED=0
  CODEX_CONFIG_BACKUP=""
  CODEX_AUTH_BACKUP=""
  _cbf_stamp=$(date +%Y%m%d%H%M%S).$$
  if [ -e "$CODEX_CONFIG_PATH" ]; then
    CODEX_CONFIG_EXISTED=1
    CODEX_CONFIG_BACKUP="$CODEX_CONFIG_PATH.floway-backup.$_cbf_stamp"
    if ! cp "$CODEX_CONFIG_PATH" "$CODEX_CONFIG_BACKUP"; then
      printf 'Floway: could not back up %s\n' "$CODEX_CONFIG_PATH" >&2
      return 1
    fi
  fi
  if [ -e "$CODEX_AUTH_PATH" ]; then
    CODEX_AUTH_EXISTED=1
    CODEX_AUTH_BACKUP="$CODEX_AUTH_PATH.floway-backup.$_cbf_stamp"
    if ! cp "$CODEX_AUTH_PATH" "$CODEX_AUTH_BACKUP"; then
      printf 'Floway: could not back up %s\n' "$CODEX_AUTH_PATH" >&2
      return 1
    fi
    chmod 600 "$CODEX_AUTH_BACKUP" 2>/dev/null || true
  fi
}

# Restore both managed files to their pre-run state: replace from backup when
# one existed, or remove the file when this run created it. Each file is handled
# independently so one failure does not abandon the other, and any restoration
# that itself fails leaves its backup untouched, prints a prominent path-specific
# message, and makes the function return non-zero for the caller to aggregate.
codex_rollback() {
  _cxr_rc=0
  if [ "${CODEX_CONFIG_EXISTED:-0}" -eq 1 ]; then
    if [ -n "${CODEX_CONFIG_BACKUP:-}" ] && [ -e "$CODEX_CONFIG_BACKUP" ]; then
      if ! mv "$CODEX_CONFIG_BACKUP" "$CODEX_CONFIG_PATH" 2>/dev/null; then
        printf 'Floway: WARNING could not restore %s from its backup; your original file is preserved at %s — restore it by hand.\n' \
          "$CODEX_CONFIG_PATH" "$CODEX_CONFIG_BACKUP" >&2
        _cxr_rc=1
      fi
    fi
  elif ! rm -f "$CODEX_CONFIG_PATH" 2>/dev/null; then
    printf 'Floway: WARNING could not remove the Codex config this run created at %s — remove it by hand.\n' \
      "$CODEX_CONFIG_PATH" >&2
    _cxr_rc=1
  fi
  if [ "${CODEX_AUTH_EXISTED:-0}" -eq 1 ]; then
    if [ -n "${CODEX_AUTH_BACKUP:-}" ] && [ -e "$CODEX_AUTH_BACKUP" ]; then
      if ! mv "$CODEX_AUTH_BACKUP" "$CODEX_AUTH_PATH" 2>/dev/null; then
        printf 'Floway: WARNING could not restore %s from its backup; your original ChatGPT login is preserved at %s — restore it by hand.\n' \
          "$CODEX_AUTH_PATH" "$CODEX_AUTH_BACKUP" >&2
        _cxr_rc=1
      fi
    fi
  elif ! rm -f "$CODEX_AUTH_PATH" 2>/dev/null; then
    printf 'Floway: WARNING could not remove the Codex auth this run created at %s — remove it by hand.\n' \
      "$CODEX_AUTH_PATH" >&2
    _cxr_rc=1
  fi
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
  _cas_timeout=${FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS:-60}
  _cas_dir=$(mktemp -d "$FLOWAY_SETUP_TMPDIR/codex-appserver.XXXXXX") || return 1
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
  _cwc_base="${FLOWAY_BASE_URL%/}/azure-api.codex"
  _cwc_edits=$("$JQ" -cn \
    --arg base "$_cwc_base" \
    --arg model "$FLOWAY_CODEX_MODEL" \
    --arg effort "$FLOWAY_CODEX_REASONING_EFFORT" '
    [
      {keyPath:"model_provider",mergeStrategy:"replace",value:"floway"},
      {keyPath:"model_providers.floway.name",mergeStrategy:"replace",value:"Floway"},
      {keyPath:"model_providers.floway.base_url",mergeStrategy:"replace",value:$base},
      {keyPath:"model_providers.floway.wire_api",mergeStrategy:"replace",value:"responses"},
      {keyPath:"model_providers.floway.supports_websockets",mergeStrategy:"replace",value:true},
      {keyPath:"chatgpt_base_url",mergeStrategy:"replace",value:$base},
      {keyPath:"features.apps",mergeStrategy:"replace",value:false},
      {keyPath:"cli_auth_credentials_store",mergeStrategy:"replace",value:"file"},
      {keyPath:"model",mergeStrategy:"replace",value:(if $model == "" then null else $model end)},
      {keyPath:"model_reasoning_effort",mergeStrategy:"replace",value:(if $effort == "" then null else $effort end)}
    ]') || {
    printf 'Floway: could not build the Codex configuration edits.\n' >&2
    return 1
  }

  _cwc_result=$(codex_app_server_batch_write "$_cwc_edits")
  _cwc_rc=$?
  if [ "$_cwc_rc" -ne 0 ]; then
    case "$_cwc_rc" in
      124) printf 'Floway: the Codex app-server timed out before confirming the configuration.\n' >&2 ;;
      3) printf 'Floway: the Codex app-server reported an error writing the configuration.\n' >&2 ;;
      2) printf 'Floway: the Codex app-server returned a malformed response.\n' >&2 ;;
      1) printf 'Floway: the Codex app-server exited before confirming the configuration.\n' >&2 ;;
      *) printf 'Floway: the Codex app-server configuration failed.\n' >&2 ;;
    esac
    return 1
  fi

  _cwc_status=$(printf '%s' "$_cwc_result" | "$JQ" -r '.result.status // empty' 2>/dev/null)
  case "$_cwc_status" in
    ok)
      printf 'Floway: Codex base configuration written.\n'
      ;;
    okOverridden)
      _cwc_msg=$(printf '%s' "$_cwc_result" | "$JQ" -r '.result.overriddenMetadata.message // "an override layer applies"' 2>/dev/null)
      _cwc_layer=$(printf '%s' "$_cwc_result" | "$JQ" -r '.result.overriddenMetadata.overridingLayer.name.type // "unknown"' 2>/dev/null)
      printf 'Floway: Codex base configuration written, but a higher-precedence layer overrides it (%s; layer: %s).\n' "$_cwc_msg" "$_cwc_layer"
      ;;
    *)
      printf 'Floway: the Codex app-server did not confirm the configuration (status: %s).\n' "${_cwc_status:-none}" >&2
      return 1
      ;;
  esac
}

# Stage a minimal ChatGPT-mode auth.json: the server-rendered identity token, the
# in-memory API key as access_token, a noop refresh placeholder, and a fresh
# RFC3339 timestamp. The stage is created under umask 077 (owner-only from the
# instant it exists), validated, and atomically renamed into place. The key is
# read from the environment so it never reaches argv.
codex_stage_auth() {
  _csa_now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  _csa_stage="$CODEX_AUTH_PATH.floway-stage.$$"
  if ! FLOWAY_API_KEY="$FLOWAY_API_KEY" "$JQ" -n \
      --arg idToken "$FLOWAY_CODEX_ID_TOKEN" \
      --arg refresh "$CODEX_REFRESH_NOOP" \
      --arg lastRefresh "$_csa_now" \
      '{OPENAI_API_KEY: null, tokens: {id_token: $idToken, access_token: env.FLOWAY_API_KEY, refresh_token: $refresh}, last_refresh: $lastRefresh}' > "$_csa_stage"; then
    printf 'Floway: could not construct the Codex auth file.\n' >&2
    rm -f "$_csa_stage"
    return 1
  fi
  if ! FLOWAY_API_KEY="$FLOWAY_API_KEY" "$JQ" -e --arg idToken "$FLOWAY_CODEX_ID_TOKEN" '
      (.tokens.id_token == $idToken) and (.tokens.access_token == env.FLOWAY_API_KEY)
    ' "$_csa_stage" >/dev/null 2>&1; then
    printf 'Floway: staged Codex auth failed validation.\n' >&2
    rm -f "$_csa_stage"
    return 1
  fi
  if ! chmod 600 "$_csa_stage"; then
    rm -f "$_csa_stage"
    return 1
  fi
  if ! mv "$_csa_stage" "$CODEX_AUTH_PATH"; then
    printf 'Floway: could not replace %s\n' "$CODEX_AUTH_PATH" >&2
    rm -f "$_csa_stage"
    return 1
  fi
}

# Confirm the gateway's authenticated Codex model directory answers. No inference
# request is issued. When a model was selected, confirm it is present in the
# returned catalog. The key is passed through a mode-0600 curl config file so it
# never reaches the process argument list.
codex_check_models() {
  _ccm_base="${FLOWAY_BASE_URL%/}/azure-api.codex"
  _ccm_cfg="$FLOWAY_SETUP_TMPDIR/codex-curl.cfg"
  {
    printf 'silent\n'
    printf 'show-error\n'
    printf 'fail\n'
    printf 'header = "Authorization: Bearer %s"\n' "$FLOWAY_API_KEY"
  } > "$_ccm_cfg"
  chmod 600 "$_ccm_cfg" 2>/dev/null || true
  _ccm_body="$FLOWAY_SETUP_TMPDIR/codex-models.json"
  curl -K "$_ccm_cfg" --connect-timeout 10 --max-time 30 -o "$_ccm_body" "$_ccm_base/models"
  _ccm_rc=$?
  rm -f "$_ccm_cfg"
  if [ "$_ccm_rc" -ne 0 ]; then
    rm -f "$_ccm_body"
    return 1
  fi
  if [ -n "$FLOWAY_CODEX_MODEL" ]; then
    if ! "$JQ" -e --arg m "$FLOWAY_CODEX_MODEL" 'any(.models[]?; .slug == $m)' "$_ccm_body" >/dev/null 2>&1; then
      printf 'Floway: the selected Codex model %s is not in the gateway catalog.\n' "$FLOWAY_CODEX_MODEL" >&2
      rm -f "$_ccm_body"
      return 1
    fi
  fi
  rm -f "$_ccm_body"
}

# Verify Codex without inference: reparse the staged auth and assert the identity
# token and key (never printing them), print the raw CLI version, and reach the
# authenticated model directory (confirming the selected model when one is set).
codex_verify() {
  if ! FLOWAY_API_KEY="$FLOWAY_API_KEY" "$JQ" -e --arg idToken "$FLOWAY_CODEX_ID_TOKEN" '
      (.tokens.id_token == $idToken) and (.tokens.access_token == env.FLOWAY_API_KEY)
    ' "$CODEX_AUTH_PATH" >/dev/null 2>&1; then
    printf 'Floway: the written Codex auth did not reparse as expected.\n' >&2
    return 1
  fi

  _cv_timeout=${FLOWAY_INSTALLER_TEST_TIMEOUT_SECONDS:-30}
  _cv_version_file="$FLOWAY_SETUP_TMPDIR/codex-version.out"
  if _run_with_timeout "$_cv_timeout" "$CODEX_BIN" --version > "$_cv_version_file" 2>&1; then
    printf 'Floway: Codex version: %s\n' "$(cat "$_cv_version_file")"
  else
    _cv_version_status=$?
    if [ "$_cv_version_status" -eq 124 ]; then
      printf 'Floway: `codex --version` timed out.\n' >&2
    else
      printf 'Floway: `codex --version` failed.\n' >&2
    fi
    return 1
  fi

  if ! codex_check_models; then
    printf 'Floway: could not reach the authenticated Codex model directory at %s/azure-api.codex/models\n' "${FLOWAY_BASE_URL%/}" >&2
    return 1
  fi
  printf 'Floway: reached the authenticated Codex model directory (no inference issued).\n'
}

# Configure Codex as one transactional unit. jq must resolve before any mutation.
# Both managed files are backed up first; a failure in the config write, auth
# staging, or verification restores both (or removes newly created files). A
# freshly installed CLI is never uninstalled.
configure_codex() {
  printf 'Floway: configuring Codex...\n'
  if ! ensure_jq; then
    printf 'Floway: jq is required to configure Codex but is unavailable and could not be provisioned for this platform. Install jq and re-run.\n' >&2
    return 1
  fi
  if ! codex_ensure_installed; then
    printf 'Floway: Codex CLI is unavailable and could not be installed.\n' >&2
    return 1
  fi
  codex_resolve_home
  if ! mkdir -p "$CODEX_HOME_DIR"; then
    printf 'Floway: could not create %s\n' "$CODEX_HOME_DIR" >&2
    return 1
  fi
  if ! codex_build_id_token; then
    return 1
  fi
  if ! codex_backup_files; then
    return 1
  fi
  if ! codex_write_config; then
    codex_rollback
    return 1
  fi
  if ! codex_stage_auth; then
    printf 'Floway: Codex auth staging failed; rolling back configuration and auth.\n' >&2
    codex_rollback
    return 1
  fi
  if ! codex_verify; then
    printf 'Floway: Codex verification failed; rolling back configuration and auth.\n' >&2
    codex_rollback
    return 1
  fi
  printf 'Floway: Codex configured.\n'
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
