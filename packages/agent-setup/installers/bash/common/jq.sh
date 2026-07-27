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
