# VSCode Agent Setup fragment.

# VSCode reads bring-your-own-key model groups from `chatLanguageModels.json`
# in its user data profile directory, so the installer writes the converted
# groups there (merging the Floway group into any existing groups) instead of
# asking the user to paste them by hand.
# Ref: https://code.visualstudio.com/docs/agent-customization/language-models
vscode_write_settings() {
  _vs_converted="$SETUP_TMPDIR/vscode-converted.json"
  if ! harness_run_converter vscode > "$_vs_converted"; then
    out_error 'failed to convert the Floway model list to VSCode settings.'
    rm -f "$_vs_converted"
    return 1
  fi
  if ! grep -q '"models"' "$_vs_converted"; then
    out_error 'the VSCode converter produced no model settings.'
    rm -f "$_vs_converted"
    return 1
  fi

  # The converter cannot know the API key, so inject the real one into the
  # Floway group before merging. VSCode sends a literal apiKey as the bearer.
  _vs_keyed="$SETUP_TMPDIR/vscode-keyed.json"
  if ! SETUP_API_KEY="$SETUP_API_KEY" "$JQ" '
      map(if .name == "Floway" then .apiKey = env.SETUP_API_KEY else . end)
    ' "$_vs_converted" > "$_vs_keyed"; then
    out_error 'could not inject the API key into the VSCode settings.'
    rm -f "$_vs_converted" "$_vs_keyed"
    return 1
  fi
  rm -f "$_vs_converted"
  _vs_converted="$_vs_keyed"

  case "$(uname -s)" in
    Darwin) _vs_dir="${VSCODE_CONFIG_DIR:-$HOME/Library/Application Support/Code/User}" ;;
    Linux) _vs_dir="${VSCODE_CONFIG_DIR:-$HOME/.config/Code/User}" ;;
    *)
      out_error 'automatic VSCode configuration supports macOS and Linux only in the Bash installer.'
      return 1
      ;;
  esac
  VSCode_SETTINGS_PATH="$_vs_dir/chatLanguageModels.json"
  VSCode_SETTINGS_BACKUP=""
  VSCode_SETTINGS_EXISTED=0

  if ! mkdir -p "$_vs_dir"; then
    out_error "could not create $_vs_dir"
    return 1
  fi

  if [ -e "$VSCode_SETTINGS_PATH" ]; then
    VSCode_SETTINGS_EXISTED=1
    VSCode_SETTINGS_BACKUP="$VSCode_SETTINGS_PATH.floway-backup.$(date +%Y%m%d%H%M%S).$$"
    if ! cp "$VSCode_SETTINGS_PATH" "$VSCode_SETTINGS_BACKUP"; then
      out_error "could not back up $VSCode_SETTINGS_PATH"
      return 1
    fi
  fi

  _vs_stage="$VSCode_SETTINGS_PATH.floway-stage.$$"
  # Merge the converted Floway group into the existing group list, replacing any
  # prior Floway group while preserving unrelated groups.
  if [ "$VSCode_SETTINGS_EXISTED" -eq 1 ]; then
    "$JQ" -s '
      (.[1] | map(select(.name != "Floway"))) + .[0]
    ' "$_vs_converted" "$VSCode_SETTINGS_PATH" > "$_vs_stage"
  else
    cp "$_vs_converted" "$_vs_stage"
  fi
  if ! "$JQ" -e 'map(select(.name == "Floway" and .vendor == "customendpoint")) | length == 1' "$_vs_stage" >/dev/null 2>&1; then
    out_error 'staged VSCode settings failed validation.'
    rm -f "$_vs_stage" "$_vs_converted"
    vscode_rollback_settings
    return 1
  fi

  if ! chmod 600 "$_vs_stage"; then
    rm -f "$_vs_stage" "$_vs_converted"
    vscode_rollback_settings
    return 1
  fi

  if ! mv "$_vs_stage" "$VSCode_SETTINGS_PATH"; then
    out_error "could not replace $VSCode_SETTINGS_PATH"
    rm -f "$_vs_stage" "$_vs_converted"
    vscode_rollback_settings
    return 1
  fi
  rm -f "$_vs_converted"
  if ! _prune_managed_backups "$VSCode_SETTINGS_PATH" "$VSCode_SETTINGS_BACKUP"; then
    vscode_rollback_settings
    return 1
  fi
}

vscode_rollback_settings() {
  _restore_managed_file \
    "${VSCode_SETTINGS_EXISTED:-0}" "${VSCode_SETTINGS_BACKUP:-}" "$VSCode_SETTINGS_PATH" \
    "file" "VSCode language-model settings"
}

# Fetch the model list, convert it, and write the VSCode settings file.
configure_agent() {
  out_agent_notice 'Configuring' 'VSCode'
  if ! harness_ensure_python; then
    return 1
  fi
  if ! ensure_jq; then
    out_error 'jq is required to merge VSCode settings but is unavailable and could not be provisioned for this platform. Install jq and re-run.'
    return 1
  fi
  if ! harness_fetch_converter vscode; then
    return 1
  fi
  if ! harness_fetch_models; then
    return 1
  fi
  if ! vscode_write_settings; then
    return 1
  fi
  out_info "Written to \`$VSCode_SETTINGS_PATH\`."
  out_agent_notice 'Completed Agent Setup' 'VSCode'
}


main 'VSCode' "$@"
