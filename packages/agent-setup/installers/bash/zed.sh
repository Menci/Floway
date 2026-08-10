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
# Shape is settled before the backup exists, so this program only merges.
ZED_SETTINGS_MERGE_PROGRAM='
  . .language_models.anthropic_compatible |= (
      # Drop any entry whose key differs from the chosen name only by case
      # before writing it. The PowerShell property bag cannot hold two such
      # keys at once — adding `Floway` beside `floway` replaces it — so a half
      # that kept both would be a half that disagrees. Aligning here also means
      # a case-only rename stops leaving a stale provider in the Zed picker.
      # ASCII case, on both halves: `ascii_downcase` folds A-Z and nothing else,
      # and the PowerShell half folds the same range by hand rather than with
      # `-ieq`, which would call FLOWÄY and flowäy one name where this calls
      # them two.
      ((. // {}) | with_entries(select((.key | ascii_downcase) != ($providerName | ascii_downcase))))
      + { ($providerName): { "api_url": $apiUrl, "available_models": $models[0] } }
    )
'

# Zed appends `/v1/messages` itself, so the provider takes the bare origin —
# unlike `openai_compatible`, whose api_url carries the version segment.
zed_api_url() {
  printf '%s' "$SETUP_ENDPOINT"
}

# Every release channel shares one configuration directory: `config_dir()` has
# no channel branching, so a single file serves Stable, Preview and Nightly.
# XDG is consulted on Linux and FreeBSD only — macOS falls through to an
# unconditional `~/.config`, never `~/Library/Application Support`, and never
# `XDG_CONFIG_HOME` even when one is exported. The branch ahead of all of these
# is `--user-data-dir`, which relocates the configuration wholesale; a Zed
# started that way is out of scope here, and the override below is how an
# operator running one points this installer at it.
# Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/paths/src/paths.rs#L121-L141
zed_config_dir() {
  if [ -n "${AGENT_SETUP_TEST_ZED_CONFIG_DIR:-}" ]; then
    printf '%s' "$AGENT_SETUP_TEST_ZED_CONFIG_DIR"
  elif [ "$(uname -s)" = Darwin ]; then
    printf '%s/.config/zed' "$HOME"
  elif [ -n "${FLATPAK_XDG_CONFIG_HOME:-}" ]; then
    printf '%s/zed' "$FLATPAK_XDG_CONFIG_HOME"
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
# `available_models` is a required array — so the gateway projects the catalog
# and embeds it in this script. Written to a file rather than passed as a jq
# argument: a large catalog would exceed the per-argument size limit, and
# --slurpfile reads it back as $models[0].
#
# Kept ahead of the settings write so neither this nor the empty check can fail
# after a backup exists — the write is then the only step that can need rollback
# — and so the credential is never stored for a provider that is not registered.
zed_stage_models() {
  ZED_MODELS_PROJECTED="$SETUP_TMPDIR/zed-available-models.json"
  printf '%s' "$SETUP_ZED_MODELS" > "$ZED_MODELS_PROJECTED"
  if ! ZED_MODEL_COUNT=$("$JQ" 'length' "$ZED_MODELS_PROJECTED"); then
    out_error 'the embedded Zed model list is not readable.'
    return 1
  fi
  if [ "$ZED_MODEL_COUNT" -eq 0 ]; then
    out_error 'no chat model this gateway serves can be configured for Zed.'
    return 1
  fi
}

zed_rollback_settings() {
  _restore_managed_file \
    "${ZED_SETTINGS_EXISTED:-0}" "${ZED_SETTINGS_BACKUP:-}" "$ZED_SETTINGS_PATH" \
    "file" "Zed global settings"
}

# Same-directory staging keeps the replacement rename atomic. The staged file
# inherits the mode of the document it replaces: this one holds no credential —
# Zed reads the key from the keychain — so narrowing it to `umask 077` would
# silently change permissions the operator chose, unlike the Claude settings
# document, which carries the key and is deliberately owner-only. A file this
# run creates is owner-only, because main sets `umask 077` before anything is
# written — the PowerShell half states the same mode explicitly.
zed_write_settings() {
  if ! ZED_SETTINGS_PATH=$(_resolve_managed_path "$ZED_CONFIG_DIR/global_settings.json"); then
    return 1
  fi
  ZED_SETTINGS_BACKUP=""
  ZED_SETTINGS_EXISTED=0

  if [ -e "$ZED_SETTINGS_PATH" ]; then
    ZED_SETTINGS_EXISTED=1
    # Zed reads this file with serde_json_lenient, so a comment or a trailing
    # comma is the operator's content and jq is about to refuse it. Name that
    # cause rather than reporting a malformed object.
    # The status is captured rather than branched on directly, because the
    # scanner answers with three of them and `$?` would be clobbered by the
    # `case` itself.
    _zw_verdict=0
    _json_has_jsonc_syntax "$ZED_SETTINGS_PATH" || _zw_verdict=$?
    case $_zw_verdict in
      0)
        out_error "$ZED_SETTINGS_PATH carries JSONC syntax this installer cannot preserve; leaving it untouched."
        return 1
        ;;
      2)
        # jq would take NaN or Infinity and rewrite it, changing a value this
        # run was not asked to touch. The PowerShell half refuses the document
        # outright, and one file has to get one answer.
        out_error "$ZED_SETTINGS_PATH is not a valid Zed settings document; leaving it untouched."
        return 1
        ;;
    esac
    # `-s -e` rather than a filter that raises: jq runs a filter zero times on
    # empty input and still exits 0, and runs it once per document on a stream,
    # so both a truncated file and `{"a":1}{"b":2}` would pass an unslurped
    # gate and fail later as a staging error naming the wrong cause. Slurping
    # asks for exactly one document.
    # The nested shape checks belong here too, not in the merge program: the
    # merge does not run until a backup exists, so a `language_models` of null
    # or 5 was refused with "failed to construct updated Zed global settings" —
    # naming our list rather than the operator's file — plus a raw jq error on
    # stderr. The PowerShell half and the VS Code installer both check
    # everything their merge can abort on before copying.
    # The `language_models` conjunct would be redundant if judged by outcome
    # alone: the one after it calls `has` on the same value, which raises on a
    # non-object and fails the gate anyway. It stays because refusing by type
    # is what this gate means, and leaning on a raised jq error would make the
    # next edit to the conjunct below silently take this case with it.
    if ! "$JQ" -s -e '
        length == 1
        and (.[0] | type == "object")
        and (.[0] | (has("language_models") | not) or (.language_models | type == "object"))
        and (.[0] | (has("language_models") | not)
             or (.language_models | has("anthropic_compatible") | not)
             or (.language_models.anthropic_compatible | type == "object"))
      ' "$ZED_SETTINGS_PATH" >/dev/null 2>&1; then
      out_error "$ZED_SETTINGS_PATH is not a valid Zed settings document; leaving it untouched."
      return 1
    fi
    _zw_base=$(cat "$ZED_SETTINGS_PATH")
    ZED_SETTINGS_BACKUP="$ZED_SETTINGS_PATH.floway-backup.$(date +%Y%m%d%H%M%S).$$"
    # `-p` because the backup is the file this run may have to restore: created
    # under `umask 077` it would come back narrower than the operator's own
    # file, so a run that reports leaving the settings untouched would still
    # have changed their mode.
    if ! cp -p "$ZED_SETTINGS_PATH" "$ZED_SETTINGS_BACKUP"; then
      out_error "could not back up $ZED_SETTINGS_PATH"
      return 1
    fi
  else
    _zw_base='{}'
  fi

  _zw_stage="$ZED_SETTINGS_PATH.floway-stage.$$"
  # The projection is read from disk rather than passed as an argument: a large
  # catalog would exceed the per-argument size limit, and it is already a file.
  if ! printf '%s' "$_zw_base" | "$JQ" \
      --arg providerName "$SETUP_ZED_PROVIDER_NAME" \
      --arg apiUrl "$(zed_api_url)" \
      --slurpfile models "$ZED_MODELS_PROJECTED" \
      "$ZED_SETTINGS_MERGE_PROGRAM" > "$_zw_stage"; then
    out_error 'failed to construct updated Zed global settings.'
    rm -f "$_zw_stage"
    zed_rollback_settings
    return 1
  fi

  # An assertion on the merge program, not a gate on operator input: every
  # malformed document is refused before the backup, so nothing reachable fails
  # this. It is what keeps a silently wrong merge from being renamed over the
  # operator's file. The PowerShell half asserts the same shape, and compares
  # the model count exactly because a nested list is a failure mode jq has no
  # equivalent of.
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

  # Carry the existing document's mode onto the replacement before it takes its
  # place, so a run cannot narrow a file it was only asked to edit. `chmod
  # --reference` would read and apply it in one step but is GNU-only, so the
  # mode is read explicitly here. The PowerShell half asks the same two stat
  # dialects inline rather than sharing this helper, which lives on this side
  # only — the two are kept in step by the fixture, not by one implementation.
  # A mode neither stat dialect answers is left alone rather than guessed at.
  if [ "$ZED_SETTINGS_EXISTED" -eq 1 ]; then
    _zw_mode=$(_stat_mode "$ZED_SETTINGS_PATH")
    [ -n "$_zw_mode" ] && chmod "$_zw_mode" "$_zw_stage"
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
  out_info "Configured $ZED_MODEL_COUNT model(s) as provider \"$SETUP_ZED_PROVIDER_NAME\"."
}

# The API key is not a setting: Zed reads it from the OS credential store,
# indexed by the provider's `api_url` under the fixed username "Bearer". The
# store is written directly rather than through Zed, which offers no CLI.
#
# `-T` grants a bundle access without the authorization prompt a later read
# would raise, and a path that does not exist fails the whole call — so only
# bundles found on this host are named, across every channel and both install
# locations. Naming none is better than naming a missing one: the item is still
# written, and Zed prompts once on first read.
zed_macos_app_bundles() {
  for _zma_app in \
      '/Applications/Zed.app' "$HOME/Applications/Zed.app" \
      '/Applications/Zed Preview.app' "$HOME/Applications/Zed Preview.app" \
      '/Applications/Zed Nightly.app' "$HOME/Applications/Zed Nightly.app"; do
    [ -d "$_zma_app" ] && printf '%s\n' "$_zma_app"
  done
  return 0
}

# macOS keeps the key as an internet password, where Zed's `url` is the server
# and its username the account — exactly what `-s` and `-a` set below.
# Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/gpui_macos/src/platform.rs#L1151-L1170
#
# `-U` makes a re-run idempotent. The key is unavoidably an argv element for the
# duration of this call: `security` takes the password only via `-w`/`-X`, and
# bare `-w` prompts on the tty rather than reading stdin, which a piped
# installer cannot answer. Verified against security(1) on macOS 15.
zed_store_key_macos() {
  if ! command -v security >/dev/null 2>&1; then
    out_error 'the `security` command is unavailable; cannot store the API key.'
    return 1
  fi
  set -- -s "$(zed_api_url)" -a Bearer -U -w "$SETUP_API_KEY"
  while IFS= read -r _zsk_app; do
    [ -n "$_zsk_app" ] || continue
    set -- "$@" -T "$_zsk_app"
  done <<EOF
$(zed_macos_app_bundles)
EOF
  security add-internet-password "$@"
}

# Linux goes through the Secret Service. Zed's lookup searches on `url` alone
# and then returns the first item whose label matches this literal, so the label
# is fixed rather than derived from the provider name.
# Ref: https://github.com/zed-industries/zed/blob/cc053a4a6fa2fd0e8793201ed9099466af1be0b1/crates/gpui_linux/src/linux/platform.rs#L677-L681
#      https://github.com/zed-industries/zed/issues/43671
ZED_KEYRING_LABEL='zed-github-account'

zed_store_key_secret_service() {
  if ! command -v secret-tool >/dev/null 2>&1; then
    out_error 'secret-tool is unavailable; install libsecret-tools (Debian/Ubuntu) or libsecret (Fedora/Arch) and re-run.'
    return 1
  fi
  printf '%s' "$SETUP_API_KEY" | secret-tool store \
    --label="$ZED_KEYRING_LABEL" url "$(zed_api_url)" username Bearer
}

zed_store_key() {
  case "$(uname -s)" in
    Darwin) zed_store_key_macos ;;
    *) zed_store_key_secret_service ;;
  esac
}

# Projection runs before the credential so an unusable catalog is refused
# without leaving a keychain entry behind, and the credential is stored before
# the settings document so a failure there leaves an unreferenced entry rather
# than a registered provider Zed reports as unauthenticated — without a key
# `is_authenticated()` is false and every model vanishes from the picker with no
# error shown.
configure_agent() {
  out_agent_notice 'Configuring' 'Zed'
  if ! zed_require_config_dir; then
    return 1
  fi
  if ! ensure_jq; then
    out_error 'jq is required to update Zed settings.'
    return 1
  fi
  if ! zed_stage_models; then
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

