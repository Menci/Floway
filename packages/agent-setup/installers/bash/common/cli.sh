# Download an installer to the private working directory, refuse anything that
# is not a shell script (region blocks and captive portals serve HTML in place
# of the real installer), then execute it without sudo.
_download_and_run_installer() {
  _dri_url=$1
  _dri_file=$(mktemp "$SETUP_TMPDIR/install.XXXXXX") || return 1
  _dri_max_bytes=${AGENT_SETUP_TEST_DOWNLOAD_MAX_BYTES:-8388608}
  # curl 8.4+ enforces the ceiling during unknown-length transfers; the byte
  # count below covers older curl builds before anything executes.
  # Ref: https://curl.se/docs/manpage.html#--max-filesize
  curl -fsSL --connect-timeout 10 --max-time 120 --max-filesize "$_dri_max_bytes" -o "$_dri_file" "$_dri_url"
  _dri_curl_rc=$?
  if [ "$_dri_curl_rc" -ne 0 ]; then
    if [ "$_dri_curl_rc" -eq 63 ]; then
      out_error 'the installer download exceeded the 8 MiB size limit.'
    else
      out_error "could not download the installer from $_dri_url"
    fi
    rm -f "$_dri_file"
    return 1
  fi
  if ! _dri_size=$(wc -c < "$_dri_file"); then
    out_error 'could not measure the installer download.'
    rm -f "$_dri_file"
    return 1
  fi
  if [ "$_dri_size" -gt "$_dri_max_bytes" ]; then
    out_error 'the installer download exceeded the 8 MiB size limit.'
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
  # `command -v` also returns inherited shell functions. Resolve only an
  # executable file from PATH so a function cannot impersonate an agent CLI in
  # the secret-bearing installer shell.
  DISCOVERED_BIN=$(type -P -- "$_dc_name" 2>/dev/null || true)
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
