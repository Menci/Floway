# Zed Agent Setup fragment.

# Merge the converted Zed settings into the existing global_settings.json. The
# converter emits `{language_models: {openai_compatible: {Floway: {...}}}}`;
# that subtree is merged into the existing document so unrelated settings
# survive, then the whole document is written back transactionally.
zed_write_settings() {
  _zw_dir="${ZED_CONFIG_DIR:-$HOME/.config/zed}"
  ZED_SETTINGS_PATH="$_zw_dir/global_settings.json"
  ZED_SETTINGS_BACKUP=""
  ZED_SETTINGS_EXISTED=0

  if ! mkdir -p "$_zw_dir"; then
    out_error "could not create $_zw_dir"
    return 1
  fi

  if [ -e "$ZED_SETTINGS_PATH" ]; then
    ZED_SETTINGS_EXISTED=1
    ZED_SETTINGS_BACKUP="$ZED_SETTINGS_PATH.floway-backup.$(date +%Y%m%d%H%M%S).$$"
    if ! cp "$ZED_SETTINGS_PATH" "$ZED_SETTINGS_BACKUP"; then
      out_error "could not back up $ZED_SETTINGS_PATH"
      return 1
    fi
  fi

  _zw_converted="$SETUP_TMPDIR/zed-converted.json"
  if ! harness_run_converter zed > "$_zw_converted"; then
    out_error 'failed to convert the Floway model list to Zed settings.'
    rm -f "$_zw_converted"
    zed_rollback_settings
    return 1
  fi
  if ! "$JQ" -e '.language_models.openai_compatible' "$_zw_converted" >/dev/null 2>&1; then
    out_error 'the Zed converter produced no language-model settings.'
    rm -f "$_zw_converted"
    zed_rollback_settings
    return 1
  fi

  _zw_stage="$ZED_SETTINGS_PATH.floway-stage.$$"
  # Deep-merge the converted subtree into the existing document (or a fresh
  # object when none exists), then validate the staged result.
  if [ "$ZED_SETTINGS_EXISTED" -eq 1 ]; then
    "$JQ" -s '.[0] * .[1]' "$ZED_SETTINGS_PATH" "$_zw_converted" > "$_zw_stage"
  else
    "$JQ" -n '{} * input' "$_zw_converted" > "$_zw_stage"
  fi
  if ! "$JQ" -e --arg base "$SETUP_ENDPOINT/v1" '
      .language_models.openai_compatible.Floway.api_url == $base
    ' "$_zw_stage" >/dev/null 2>&1; then
    out_error 'staged Zed settings failed validation.'
    rm -f "$_zw_stage" "$_zw_converted"
    zed_rollback_settings
    return 1
  fi

  if ! chmod 600 "$_zw_stage"; then
    rm -f "$_zw_stage" "$_zw_converted"
    zed_rollback_settings
    return 1
  fi

  if ! mv "$_zw_stage" "$ZED_SETTINGS_PATH"; then
    out_error "could not replace $ZED_SETTINGS_PATH"
    rm -f "$_zw_stage" "$_zw_converted"
    zed_rollback_settings
    return 1
  fi
  rm -f "$_zw_converted"
  if ! _prune_managed_backups "$ZED_SETTINGS_PATH" "$ZED_SETTINGS_BACKUP"; then
    zed_rollback_settings
    return 1
  fi
}

zed_rollback_settings() {
  _restore_managed_file \
    "${ZED_SETTINGS_EXISTED:-0}" "${ZED_SETTINGS_BACKUP:-}" "$ZED_SETTINGS_PATH" \
    "file" "Zed settings"
}

# Fetch the model list, convert it, and merge the Zed settings file.
configure_agent() {
  out_agent_notice 'Configuring' 'Zed'
  if ! harness_ensure_python; then
    return 1
  fi
  if ! ensure_jq; then
    out_error 'jq is required to merge Zed settings but is unavailable and could not be provisioned for this platform. Install jq and re-run.'
    return 1
  fi
  if ! harness_fetch_converter zed; then
    return 1
  fi
  if ! harness_fetch_models; then
    return 1
  fi
  if ! zed_write_settings; then
    return 1
  fi
  out_info "Written to \`$ZED_SETTINGS_PATH\`."
  out_info 'Add your Floway API key in Zed: Settings → AI → General → LLM Providers.'
  out_agent_notice 'Completed Agent Setup' 'Zed'
}


main 'Zed' "$@"
