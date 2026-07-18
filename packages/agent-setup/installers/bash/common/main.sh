# --- run --------------------------------------------------------------------

main() {
  set -u
  umask 077
  set -o pipefail 2>/dev/null || true

  # Neutralize identically named exported variables inherited from the caller.
  # jq receives the API key only on the exact invocations that need it; package
  # managers and CLIs never inherit the credential.
  export -n SETUP_API_KEY SETUP_API_KEY_NAME 2>/dev/null || true

  _init_output
  out_agent_notice 'Agent Setup' "$1"

  if [ -z "${SETUP_ENDPOINT:-}" ]; then
    out_error 'SETUP_ENDPOINT must be set to this gateway origin (e.g. https://gateway.example).'
    return 1
  fi
  case "$SETUP_ENDPOINT" in
    http://?* | https://?*) ;;
    *) out_error "SETUP_ENDPOINT must be an http(s) origin, got $SETUP_ENDPOINT"; return 1 ;;
  esac
  out_metadata 'Endpoint' "$SETUP_ENDPOINT"
  out_metadata 'API Key' "$SETUP_API_KEY_NAME"
  export -n SETUP_ENDPOINT 2>/dev/null || true

  SETUP_TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-setup.XXXXXX") || {
    out_error 'could not create a private working directory.'
    return 1
  }
  chmod 700 "$SETUP_TMPDIR" 2>/dev/null || true
  trap _cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  configure_agent
}
