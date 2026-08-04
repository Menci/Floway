import { CODEX_DEFAULT_FLAGS } from './defaults.ts';
import { createCodexProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const codexProviderModule: ProviderModule = {
  create: createCodexProvider,
  // https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/codex-api/src/requests/headers.rs#L5-L12
  // https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/codex-api/src/endpoint/responses.rs#L87-L96
  // https://github.com/openai/codex/blob/c607da9f371bb66a41cc772c6ddf1989d28137d3/codex-rs/core/src/responses_metadata.rs#L255-L270
  // https://github.com/openai/codex/blob/bd8fc9adb93fa5bc0a69b396bd5ac78a5ec14487/codex-rs/codex-api/src/requests/headers.rs#L5-L16
  inboundHeaderAllowlist: {
    callAlphaSearch: ['x-codex-turn-metadata'],
    callResponses: [
      'session-id',
      'session_id',
      'thread-id',
      'x-client-request-id',
      'x-codex-turn-metadata',
      'x-codex-window-id',
    ],
  },
  defaultFlags: CODEX_DEFAULT_FLAGS,
};

export * from './access-token.ts';
export * from './auth/import.ts';
export * from './auth/oauth.ts';
export * from './constants.ts';
export * from './config.ts';
export * from './state.ts';
export * from './quota.ts';
