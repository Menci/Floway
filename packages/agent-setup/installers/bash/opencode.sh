# opencode Agent Setup fragment.

# Merge the converted opencode settings into the existing config. The converter
# emits `{$schema, provider: {Floway: {...}}}`; the provider subtree is merged
# into the existing document so unrelated settings survive, then the whole
# document is written back transactionally.
opencode_write_settings() {
  _ow_dir="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"
  OPENCODE_CONFIG_PATH="$_ow_dir/opencode.json"
  OPENCODE_CONFIG_BACKUP=""
  OPENCODE_CONFIG_EXISTED=0

  if ! mkdir -p "$_ow_dir"; then
    out_error "could not create $_ow_dir"
    return 1
  fi

  if [ -e "$OPENCODE_CONFIG_PATH" ]; then
    OPENCODE_CONFIG_EXISTED=1
    OPENCODE_CONFIG_BACKUP="$OPENCODE_CONFIG_PATH.floway-backup.$(date +%Y%m%d%H%M%S).$$"
    if ! cp "$OPENCODE_CONFIG_PATH" "$OPENCODE_CONFIG_BACKUP"; then
      out_error "could not back up $OPENCODE_CONFIG_PATH"
      return 1
    fi
  fi

  _ow_converted="$SETUP_TMPDIR/opencode-converted.json"
  if ! harness_run_converter opencode > "$_ow_converted"; then
    out_error 'failed to convert the Floway model list to opencode settings.'
    rm -f "$_ow_converted"
    opencode_rollback_settings
    return 1
  fi
  if ! "$JQ" -e '.provider' "$_ow_converted" >/dev/null 2>&1; then
    out_error 'the opencode converter produced no provider settings.'
    rm -f "$_ow_converted"
    opencode_rollback_settings
    return 1
  fi

  # The converter cannot know the API key, so inject the real one into the
  # provider options. opencode sends a literal options.apiKey as the bearer.
  _ow_keyed="$SETUP_TMPDIR/opencode-keyed.json"
  if ! SETUP_API_KEY="$SETUP_API_KEY" "$JQ" '
      .provider.Floway.options.apiKey = env.SETUP_API_KEY
    ' "$_ow_converted" > "$_ow_keyed"; then
    out_error 'could not inject the API key into the opencode settings.'
    rm -f "$_ow_converted" "$_ow_keyed"
    opencode_rollback_settings
    return 1
  fi
  rm -f "$_ow_converted"
  _ow_converted="$_ow_keyed"

  _ow_stage="$OPENCODE_CONFIG_PATH.floway-stage.$$"
  # Deep-merge the converted provider subtree into the existing document (or a
  # fresh object when none exists), then validate the staged result.
  if [ "$OPENCODE_CONFIG_EXISTED" -eq 1 ]; then
    "$JQ" -s '.[0] * .[1]' "$OPENCODE_CONFIG_PATH" "$_ow_converted" > "$_ow_stage"
  else
    "$JQ" -n '{} * input' "$_ow_converted" > "$_ow_stage"
  fi
  if ! "$JQ" -e --arg base "$SETUP_ENDPOINT/v1" '
      .provider.Floway.options.baseURL == $base
    ' "$_ow_stage" >/dev/null 2>&1; then
    out_error 'staged opencode settings failed validation.'
    rm -f "$_ow_stage" "$_ow_converted"
    opencode_rollback_settings
    return 1
  fi

  if ! chmod 600 "$_ow_stage"; then
    rm -f "$_ow_stage" "$_ow_converted"
    opencode_rollback_settings
    return 1
  fi

  if ! mv "$_ow_stage" "$OPENCODE_CONFIG_PATH"; then
    out_error "could not replace $OPENCODE_CONFIG_PATH"
    rm -f "$_ow_stage" "$_ow_converted"
    opencode_rollback_settings
    return 1
  fi
  rm -f "$_ow_converted"
  if ! _prune_managed_backups "$OPENCODE_CONFIG_PATH" "$OPENCODE_CONFIG_BACKUP"; then
    opencode_rollback_settings
    return 1
  fi
}

opencode_rollback_settings() {
  _restore_managed_file \
    "${OPENCODE_CONFIG_EXISTED:-0}" "${OPENCODE_CONFIG_BACKUP:-}" "$OPENCODE_CONFIG_PATH" \
    "file" "opencode settings"
}

# Fetch the model list, convert it, and merge the opencode config file.
configure_agent() {
  out_agent_notice 'Configuring' 'opencode'
  if ! harness_ensure_python; then
    return 1
  fi
  if ! ensure_jq; then
    out_error 'jq is required to merge opencode settings but is unavailable and could not be provisioned for this platform. Install jq and re-run.'
    return 1
  fi
  if ! harness_fetch_converter opencode; then
    return 1
  fi
  if ! harness_fetch_models; then
    return 1
  fi
  if ! opencode_write_settings; then
    return 1
  fi
  out_info "Written to \`$OPENCODE_CONFIG_PATH\`."
  out_agent_notice 'Completed Agent Setup' 'opencode'
}


main 'opencode' "$@"
