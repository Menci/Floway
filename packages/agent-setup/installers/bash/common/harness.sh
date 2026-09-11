# Shared harness-converter helpers for the oh-my-pi, VSCode, Zed, and opencode
# Agent Setup fragments. Each target is configured by a Python converter served
# by this gateway that turns the /v1/models payload into editor-specific
# settings; these helpers fetch the model list, download the converter, and run
# it. The converter never sees the API key — the fetch carries it, and python3
# runs with the credential unset.
HARNESS_CONVERTER=""
HARNESS_MODELS=""

harness_ensure_python() {
  if ! command -v python3 >/dev/null 2>&1; then
    out_error 'python3 is required to convert the Floway model list into editor settings.'
    return 1
  fi
}

# $1 = converter basename (omp, vscode, zed, opencode). Downloads the served
# converter into the private working directory; it carries no secret, so the
# download needs no bearer header.
harness_fetch_converter() {
  _hfc_name=$1
  _hfc_url="$SETUP_ENDPOINT/api/setup/harness/$_hfc_name.py"
  HARNESS_CONVERTER="$SETUP_TMPDIR/floway-to-$_hfc_name.py"
  if ! curl -fsSL --connect-timeout 10 --max-time 120 -o "$HARNESS_CONVERTER" "$_hfc_url"; then
    out_error "could not download the converter from $_hfc_url"
    rm -f "$HARNESS_CONVERTER"
    HARNESS_CONVERTER=""
    return 1
  fi
}

# Fetches the Floway model list with the embedded API key. The key travels in
# the Authorization header only, so it never reaches argv or the converter.
harness_fetch_models() {
  HARNESS_MODELS="$SETUP_TMPDIR/models.json"
  if ! curl -fsSL --connect-timeout 10 --max-time 120 --oauth2-bearer "$SETUP_API_KEY" "$SETUP_ENDPOINT/v1/models" -o "$HARNESS_MODELS"; then
    out_error 'could not fetch the Floway model list.'
    rm -f "$HARNESS_MODELS"
    HARNESS_MODELS=""
    return 1
  fi
}

# $1 = converter basename. Runs the converter over the fetched models and
# writes the converted settings to stdout.
harness_run_converter() {
  _hrc_name=$1
  python3 "$SETUP_TMPDIR/floway-to-$_hrc_name.py" 'Floway' "$SETUP_ENDPOINT/v1" < "$HARNESS_MODELS"
}
