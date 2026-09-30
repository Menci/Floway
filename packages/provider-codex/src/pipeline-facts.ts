import type { CodexPlanObservation } from './access-token.ts';
import type { CodexCallEffects, CodexBackendCallBase } from './backend.ts';
import type { CodexAccountCredential, CodexAccessTokenEntry } from './state.ts';
import type { HttpRequestFacts } from '@floway-dev/http/pipeline';
import { secret, type Secret } from '@floway-dev/pipeline';
import type { ProviderModelFacts, ProviderOperationPayloads, ProviderRequest, ProviderServices } from '@floway-dev/provider';

export type CodexOperation = 'alphaSearch' | 'openaiImagesGenerations' | 'openaiImagesEdits' | 'openaiResponses' | 'openaiResponsesCompact';
export type CodexRequest<O extends CodexOperation = CodexOperation> = ProviderRequest<ProviderOperationPayloads[O]>;
export type CodexToken = Omit<CodexAccessTokenEntry, 'token'> & { readonly token: Secret<string> };
export type CodexAccount = Omit<CodexAccountCredential, 'refresh_token' | 'accessToken'> & {
  readonly refresh_token: Secret<string> | null;
  readonly accessToken: CodexToken | null;
};
export type CodexAccountFacts<O extends CodexOperation = CodexOperation> = CodexRequest<O> & {
  'request.codex.account': CodexAccount;
};
export type CodexAuthenticatedFacts<O extends CodexOperation = CodexOperation> = CodexAccountFacts<O> & {
  'request.codex.accessToken': CodexToken;
  'request.codex.plan': CodexPlanObservation | null;
};
export interface CodexHttpFacts extends HttpRequestFacts {
  'request.codex.model': ProviderModelFacts;
  'request.codex.account': CodexAccount;
  'request.codex.accessToken': CodexToken;
  'request.codex.plan': CodexPlanObservation | null;
  'request.codex.modelKey': string;
  'request.provider.modelKey': string;
}

export interface CodexPipelineConfig {
  readonly upstreamId: string;
  readonly fallbackPlanType: string | undefined;
  readonly readAccount: () => Promise<CodexAccountCredential>;
  readonly effects: CodexCallEffects;
}

export const tokenFacts = (entry: CodexAccessTokenEntry): CodexToken => ({ ...entry, token: secret(entry.token) });
export const accountFacts = (account: CodexAccountCredential): CodexAccount => ({
  ...account,
  refresh_token: account.refresh_token === null ? null : secret(account.refresh_token),
  accessToken: account.accessToken === null ? null : tokenFacts(account.accessToken),
});
export const accountValue = (account: CodexAccount): CodexAccountCredential => ({
  ...account,
  refresh_token: account.refresh_token === null ? null : account.refresh_token.reveal(),
  accessToken: account.accessToken === null ? null : { ...account.accessToken, token: account.accessToken.token.reveal() },
});

export const codexCall = (
  config: CodexPipelineConfig,
  facts: { 'request.codex.account': CodexAccount; 'request.http.callId': number },
  use: ProviderServices,
  model: CodexBackendCallBase['model'],
): CodexBackendCallBase => {
  const call = use.httpCall(facts['request.http.callId']);
  return {
    upstreamId: config.upstreamId,
    account: accountValue(facts['request.codex.account']),
    model,
    headers: new Headers(),
    signal: call.signal,
    effects: config.effects,
    call: { ...call, headers: new Headers() },
  };
};
