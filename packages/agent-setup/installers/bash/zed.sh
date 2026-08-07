# Zed Agent Setup fragment.

# Zed is configured, not installed: the editor is distributed outside any
# package manager we could drive, so this fragment finds an existing
# configuration directory and refuses to guess when there is none.
#
# The managed document is `global_settings.json`, a settings layer Zed reads
# below the user's own `settings.json`. Zed never creates it and never writes to
# it — the sole reference in the editor is the watcher that reloads it — so a
# third party can own the file outright. Editing `settings.json` instead would
# mean a comment-preserving JSONC edit, which no portable tool does correctly.
# Ref: https://github.com/zed-industries/zed/pull/30444
ZED_SETTINGS_MERGE_PROGRAM='
  if type != "object" then error("root is not a JSON object")
  elif (has("language_models") and ((.language_models | type) != "object")) then error("language_models is not a JSON object")
  elif (has("language_models") and (.language_models | has("anthropic_compatible")) and ((.language_models.anthropic_compatible | type) != "object"))
    then error("anthropic_compatible is not a JSON object")
  else . end
  | .language_models.anthropic_compatible[$providerName] = {
      "api_url": $apiUrl,
      "available_models": $models,
    }
'

# Zed appends `/v1/messages` itself, so the provider takes the bare origin —
# unlike `openai_compatible`, whose api_url carries the version segment.
zed_api_url() {
  printf '%s' "$SETUP_ENDPOINT"
}

# Every release channel shares one configuration directory: `config_dir()` has
# no channel branching, so a single file serves Stable, Preview and Nightly.
# macOS resolves to `~/.config`, not `~/Library/Application Support`.
zed_config_dir() {
  if [ -n "${ZED_CONFIG_DIR_OVERRIDE:-}" ]; then
    printf '%s' "$ZED_CONFIG_DIR_OVERRIDE"
  elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
    printf '%s/zed' "$XDG_CONFIG_HOME"
  else
    printf '%s/.config/zed' "$HOME"
  fi
}

# Absence is a hard stop rather than a directory we create: Zed has never run
# here, and a settings file alone would not make the editor exist.
zed_require_config_dir() {
  ZED_CONFIG_DIR=$(zed_config_dir)
  if [ -d "$ZED_CONFIG_DIR" ]; then
    out_info "Zed configuration directory: $ZED_CONFIG_DIR"
    return 0
  fi
  out_error "no Zed configuration directory at $ZED_CONFIG_DIR; install and launch Zed once, then re-run this command."
  return 1
}

# Zed's `anthropic_compatible` provider has no model-discovery path — its
# `available_models` is a required array — so the catalog is snapshotted here
# and the operator re-runs this command after changing it upstream.
zed_fetch_models() {
  _zfm_body="$SETUP_TMPDIR/zed-models.json"
  if ! curl -fsSL --connect-timeout 10 --max-time 60 \
      -H "Authorization: Bearer $SETUP_API_KEY" \
      -o "$_zfm_body" "$SETUP_ENDPOINT/v1/models"; then
    out_error "could not fetch the model catalog from $SETUP_ENDPOINT/v1/models"
    return 1
  fi
  ZED_MODELS_FILE="$_zfm_body"
}

# Chat models only, keyed on `kind` rather than on `endpoints`: the endpoint map
# describes the upstream wire surface, and translation lets any chat model serve
# a Messages request regardless of which key it advertises.
#
# `tools` is always true — a model that cannot call tools is not a model anyone
# would route here. `prompt_caching` is on because Zed defaults it off, which
# suppresses cache_control breakpoints entirely; enabled it sends explicit
# per-message breakpoints that tell the gateway where the stable prefix ends.
ZED_MODELS_PROGRAM='
  [ .data[]
    | select(.kind == "chat")
    | {
        name: .id,
        display_name: .display_name,
        max_tokens: (.limits.max_context_window_tokens // .limits.max_prompt_tokens // 200000),
        capabilities: {
          tools: true,
          images: ((.chat.modalities.input // []) | index("image") != null),
          prompt_caching: true,
        },
      }
      + (if .limits.max_output_tokens then { max_output_tokens: .limits.max_output_tokens } else {} end)
      + (if (.chat.reasoning | not) then {}
         elif .chat.reasoning.adaptive then { mode: { type: "adaptive" } }
         else { mode: ({ type: "thinking" }
           + (if .chat.reasoning.budget_tokens.max
              then { budget_tokens: .chat.reasoning.budget_tokens.max }
              else {} end)) }
         end)
  ]
'

zed_rollback_settings() {
  _restore_managed_file \
    "${ZED_SETTINGS_EXISTED:-0}" "${ZED_SETTINGS_BACKUP:-}" "$ZED_SETTINGS_PATH" \
    "file" "Zed global settings"
}

# Same-directory staging keeps the replacement rename atomic. The file holds no
# credential — Zed reads the key from the keychain — so it keeps the default
# umask rather than the 0600 the Claude settings document needs.
zed_write_settings() {
  ZED_SETTINGS_PATH="$ZED_CONFIG_DIR/global_settings.json"
  ZED_SETTINGS_BACKUP=""
  ZED_SETTINGS_EXISTED=0

  if [ -e "$ZED_SETTINGS_PATH" ]; then
    ZED_SETTINGS_EXISTED=1
    if ! "$JQ" 'if type != "object" then error("root is not a JSON object") else . end' \
        "$ZED_SETTINGS_PATH" >/dev/null 2>&1; then
      out_error "$ZED_SETTINGS_PATH is not a valid JSON object; leaving it untouched."
      return 1
    fi
    _zw_base=$(cat "$ZED_SETTINGS_PATH")
    ZED_SETTINGS_BACKUP="$ZED_SETTINGS_PATH.floway-backup.$(date +%Y%m%d%H%M%S).$$"
    if ! cp "$ZED_SETTINGS_PATH" "$ZED_SETTINGS_BACKUP"; then
      out_error "could not back up $ZED_SETTINGS_PATH"
      return 1
    fi
  else
    _zw_base='{}'
  fi

  if ! _zw_models=$("$JQ" -c "$ZED_MODELS_PROGRAM" "$ZED_MODELS_FILE"); then
    out_error 'failed to project the model catalog into Zed model entries.'
    return 1
  fi
  if [ "$_zw_models" = '[]' ]; then
    out_error 'the gateway advertises no chat models; nothing to configure.'
    return 1
  fi

  _zw_stage="$ZED_SETTINGS_PATH.floway-stage.$$"
  if ! printf '%s' "$_zw_base" | "$JQ" \
      --arg providerName "$SETUP_ZED_PROVIDER_NAME" \
      --arg apiUrl "$(zed_api_url)" \
      --argjson models "$_zw_models" \
      "$ZED_SETTINGS_MERGE_PROGRAM" > "$_zw_stage"; then
    out_error 'failed to construct updated Zed global settings.'
    rm -f "$_zw_stage"
    zed_rollback_settings
    return 1
  fi

  if ! "$JQ" -e --arg providerName "$SETUP_ZED_PROVIDER_NAME" --arg apiUrl "$(zed_api_url)" '
      (type == "object")
      and (.language_models.anthropic_compatible[$providerName].api_url == $apiUrl)
      and ((.language_models.anthropic_compatible[$providerName].available_models | length) > 0)
    ' "$_zw_stage" >/dev/null 2>&1; then
    out_error 'staged Zed global settings failed validation.'
    rm -f "$_zw_stage"
    zed_rollback_settings
    return 1
  fi

  if ! mv "$_zw_stage" "$ZED_SETTINGS_PATH"; then
    out_error "could not replace $ZED_SETTINGS_PATH"
    rm -f "$_zw_stage"
    zed_rollback_settings
    return 1
  fi
  if ! _prune_managed_backups "$ZED_SETTINGS_PATH" "$ZED_SETTINGS_BACKUP"; then
    zed_rollback_settings
    return 1
  fi
  out_info "Configured $(printf '%s' "$_zw_models" | "$JQ" 'length') model(s) as provider \"$SETUP_ZED_PROVIDER_NAME\"."
}

# The API key is not a setting: Zed reads it from the OS credential store,
# indexed by the provider's `api_url` under the fixed username "Bearer". The
# store is written directly rather than through Zed, which offers no CLI.
#
# macOS keeps it as an internet password whose server attribute is the whole URL
# string; `-U` makes a re-run idempotent and `-T` grants Zed access without the
# authorization prompt a later read would otherwise raise.
zed_store_key_macos() {
  if ! command -v security >/dev/null 2>&1; then
    out_error 'the `security` command is unavailable; cannot store the API key.'
    return 1
  fi
  SETUP_API_KEY="$SETUP_API_KEY" security add-internet-password \
    -s "$(zed_api_url)" -a Bearer -w "$SETUP_API_KEY" -U \
    -T /Applications/Zed.app 2>/dev/null
}

# Linux goes through the Secret Service. The label is matched exactly on read,
# so it is a fixed literal rather than anything derived from the provider name.
# Ref: https://github.com/zed-industries/zed/issues/43671
ZED_KEYRING_LABEL='zed-github-account'

zed_store_key_secret_service() {
  if ! command -v secret-tool >/dev/null 2>&1; then
    out_error 'secret-tool is unavailable; install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch) and re-run.'
    return 1
  fi
  # A prior entry is cleared first: secret-tool appends rather than replaces,
  # and Zed's lookup filters on `url` before comparing labels, so duplicates
  # would accumulate on every re-run.
  secret-tool clear url "$(zed_api_url)" username Bearer 2>/dev/null || true
  printf '%s' "$SETUP_API_KEY" | secret-tool store \
    --label="$ZED_KEYRING_LABEL" url "$(zed_api_url)" username Bearer
}

zed_store_key() {
  case "$(uname -s)" in
    Darwin) zed_store_key_macos ;;
    *) zed_store_key_secret_service ;;
  esac
}

# The credential is stored before the settings document so a failure leaves an
# unreferenced keychain entry rather than a registered provider Zed reports as
# unauthenticated — without a key `is_authenticated()` is false and every model
# vanishes from the picker with no error shown.
configure_agent() {
  out_agent_notice 'Configuring' 'Zed'
  if ! zed_require_config_dir; then
    return 1
  fi
  if ! ensure_jq; then
    out_error 'jq is required to update Zed settings.'
    return 1
  fi
  if ! zed_fetch_models; then
    return 1
  fi
  if ! zed_store_key; then
    out_error 'could not store the API key in the system credential store.'
    return 1
  fi
  if ! zed_write_settings; then
    return 1
  fi
  out_info "Written to \`$ZED_SETTINGS_PATH\`."
  out_info 'Restart Zed if it is running.'
  out_agent_notice 'Completed Agent Setup' 'Zed'
}


main 'Zed' "$@"

