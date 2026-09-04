# oh-my-pi Agent Setup fragment.

# The oh-my-pi converter emits YAML, which requires the PyYAML module. Check
# for it before any file is touched so a missing module fails cleanly.
omp_ensure_yaml() {
  if ! python3 -c 'import yaml' >/dev/null 2>&1; then
    out_error 'the oh-my-pi converter requires the PyYAML module; install it with `python3 -m pip install pyyaml`.'
    return 1
  fi
}

# Write the converted oh-my-pi settings and the API key transactionally: back
# up the existing files (if any), stage the new content in the same directory,
# validate it, and rename it into place with owner-only access. The converter
# references the key by the FLOWAY_API_KEY env name, which oh-my-pi resolves
# from its eager .env loading; the key is staged into the same agent directory
# as models.yml so omp authenticates with the real token instead of the literal
# env-var name.
# Ref: https://github.com/can1357/oh-my-pi/blob/main/docs/models.md (apiKey env-name-or-literal semantics)
# Ref: https://github.com/can1357/oh-my-pi/blob/main/packages/utils/src/env.ts (eager agent-dir .env loading)
omp_write_settings() {
  _ow_dir="${OMP_CONFIG_DIR:-$HOME/.omp}/agent"
  OMP_MODELS_PATH="$_ow_dir/models.yml"
  OMP_MODELS_BACKUP=""
  OMP_MODELS_EXISTED=0
  OMP_ENV_PATH="$_ow_dir/.env"
  OMP_ENV_BACKUP=""
  OMP_ENV_EXISTED=0

  if ! mkdir -p "$_ow_dir"; then
    out_error "could not create $_ow_dir"
    return 1
  fi

  # A single quote, backslash, or line break would break the single-quoted .env
  # line that oh-my-pi parses, so reject such keys before any file is touched.
  case "$SETUP_API_KEY" in
    *"'"* | *'\\'* | *$'\n'* | *$'\r'*)
      out_error 'the oh-my-pi API key contains characters that cannot be stored in the oh-my-pi .env file.'
      return 1
      ;;
  esac

  if [ -e "$OMP_MODELS_PATH" ]; then
    OMP_MODELS_EXISTED=1
    OMP_MODELS_BACKUP="$OMP_MODELS_PATH.floway-backup.$(date +%Y%m%d%H%M%S).$$"
    if ! cp "$OMP_MODELS_PATH" "$OMP_MODELS_BACKUP"; then
      out_error "could not back up $OMP_MODELS_PATH"
      return 1
    fi
  fi
  if [ -e "$OMP_ENV_PATH" ]; then
    OMP_ENV_EXISTED=1
    OMP_ENV_BACKUP="$OMP_ENV_PATH.floway-backup.$(date +%Y%m%d%H%M%S).$$"
    if ! cp "$OMP_ENV_PATH" "$OMP_ENV_BACKUP"; then
      out_error "could not back up $OMP_ENV_PATH"
      return 1
    fi
  fi

  _ow_stage="$OMP_MODELS_PATH.floway-stage.$$"
  if ! harness_run_converter omp > "$_ow_stage"; then
    out_error 'failed to convert the Floway model list to oh-my-pi settings.'
    rm -f "$_ow_stage"
    omp_rollback_settings
    return 1
  fi
  if ! grep -q '^providers:' "$_ow_stage"; then
    out_error 'the oh-my-pi converter produced no provider settings.'
    rm -f "$_ow_stage"
    omp_rollback_settings
    return 1
  fi

  if ! chmod 600 "$_ow_stage"; then
    rm -f "$_ow_stage"
    omp_rollback_settings
    return 1
  fi

  if ! mv "$_ow_stage" "$OMP_MODELS_PATH"; then
    out_error "could not replace $OMP_MODELS_PATH"
    rm -f "$_ow_stage"
    omp_rollback_settings
    return 1
  fi
  if ! _prune_managed_backups "$OMP_MODELS_PATH" "$OMP_MODELS_BACKUP"; then
    omp_rollback_settings
    return 1
  fi

  # Stage the key into the agent .env, preserving unrelated lines and replacing
  # any prior FLOWAY_API_KEY entry.
  _ow_env_stage="$OMP_ENV_PATH.floway-stage.$$"
  if [ -e "$OMP_ENV_PATH" ]; then
    grep -vE '^(export[[:space:]]+)?FLOWAY_API_KEY=' "$OMP_ENV_PATH" > "$_ow_env_stage" 2>/dev/null || true
  else
    : > "$_ow_env_stage"
  fi
  if ! printf "FLOWAY_API_KEY='%s'\n" "$SETUP_API_KEY" >> "$_ow_env_stage"; then
    out_error 'could not stage the oh-my-pi API key.'
    rm -f "$_ow_env_stage"
    omp_rollback_settings
    return 1
  fi
  if ! grep -q '^FLOWAY_API_KEY=' "$_ow_env_stage"; then
    out_error 'staged oh-my-pi API key failed validation.'
    rm -f "$_ow_env_stage"
    omp_rollback_settings
    return 1
  fi
  if ! chmod 600 "$_ow_env_stage"; then
    rm -f "$_ow_env_stage"
    omp_rollback_settings
    return 1
  fi
  if ! mv "$_ow_env_stage" "$OMP_ENV_PATH"; then
    out_error "could not replace $OMP_ENV_PATH"
    rm -f "$_ow_env_stage"
    omp_rollback_settings
    return 1
  fi
  if ! _prune_managed_backups "$OMP_ENV_PATH" "$OMP_ENV_BACKUP"; then
    omp_rollback_settings
    return 1
  fi
}

omp_rollback_settings() {
  _restore_managed_file \
    "${OMP_MODELS_EXISTED:-0}" "${OMP_MODELS_BACKUP:-}" "$OMP_MODELS_PATH" \
    "file" "oh-my-pi settings"
  _restore_managed_file \
    "${OMP_ENV_EXISTED:-0}" "${OMP_ENV_BACKUP:-}" "$OMP_ENV_PATH" \
    "file" "oh-my-pi API key"
}

# Fetch the model list, convert it, and install the oh-my-pi settings file.
configure_agent() {
  out_agent_notice 'Configuring' 'oh-my-pi'
  if ! harness_ensure_python; then
    return 1
  fi
  if ! omp_ensure_yaml; then
    return 1
  fi
  if ! harness_fetch_converter omp; then
    return 1
  fi
  if ! harness_fetch_models; then
    return 1
  fi
  if ! omp_write_settings; then
    return 1
  fi
  out_info "Written to \`$OMP_MODELS_PATH\`."
  out_agent_notice 'Completed Agent Setup' 'oh-my-pi'
}


main 'oh-my-pi' "$@"
