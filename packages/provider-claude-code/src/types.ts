// Per-model side data the gateway carries on ProviderModel.providerData for
// claude-code entries. The catalog advertises Anthropic's public aliases
// (`claude-sonnet-4-5`, etc.) as the public model id so clients can address
// models with the same name regardless of the dated revision Anthropic ships;
// the dated id stays as the on-wire `model` we forward to Anthropic so the
// per-revision rate-limit / pricing routing stays accurate.
export interface ClaudeCodeProviderData {
  readonly upstreamModelId: string;
}
