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
    # Let TERM→KILL escalation finish before reporting the timeout.
    wait "$_rwt_watchdog" 2>/dev/null || true
    rm -f "$_rwt_marker"
    return 124
  fi
  kill "$_rwt_watchdog" 2>/dev/null || true
  wait "$_rwt_watchdog" 2>/dev/null || true
  rm -f "$_rwt_marker"
  return $_rwt_status
}

# jq handle, resolved by ensure_jq before any configuration file is touched.
JQ=""

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
  out_warn 'jq not found on PATH; fetching the pinned jq-1.8.2 build'
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

_prune_managed_backups() {
  _pmb_path=$1
  _pmb_keep=$2
  for _pmb_backup in "$_pmb_path".floway-backup.*; do
    [ -e "$_pmb_backup" ] || continue
    [ "$_pmb_backup" = "$_pmb_keep" ] && continue
    if ! rm -f "$_pmb_backup"; then
      out_error "could not remove obsolete backup $_pmb_backup"
      return 1
    fi
  done
}

_install_brew_cask() {
  _ibc_cask=$1
  if ! command -v brew >/dev/null 2>&1; then
    out_error 'Homebrew is required to install agent CLIs on macOS.'
    return 1
  fi
  _ibc_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-600}
  _run_with_timeout "$_ibc_timeout" env -u SETUP_API_KEY brew install --cask "$_ibc_cask" </dev/null
}

_install_npm_package() {
  _inp_package=$1
  _inp_timeout=${AGENT_SETUP_TEST_TIMEOUT_SECONDS:-600}
  _run_with_timeout "$_inp_timeout" env -u SETUP_API_KEY npm install --global "$_inp_package" </dev/null
}
