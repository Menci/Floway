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
