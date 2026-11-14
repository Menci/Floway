import type { ChatGPTPlanObservation } from './access-token.ts';
import type { ChatGPTCallEffects, ChatGPTBackendCallBase } from './backend.ts';
import type { ChatGPTAccountCredential, ChatGPTAccessTokenEntry } from './state.ts';
import type { HttpRequestFacts } from '@floway-dev/http/pipeline';
import { secret, type Secret } from '@floway-dev/pipeline';
import type { ProviderModelFacts, ProviderOperationPayloads, ProviderRequest, ProviderServices } from '@floway-dev/provider';

export type ChatGPTOperation = 'alphaSearch' | 'openaiImagesGenerations' | 'openaiImagesEdits' | 'openaiResponses' | 'openaiResponsesCompact';
export type ChatGPTRequest<O extends ChatGPTOperation = ChatGPTOperation> = ProviderRequest<ProviderOperationPayloads[O]>;
export type ChatGPTToken = Omit<ChatGPTAccessTokenEntry, 'token'> & { readonly token: Secret<string> };
export type ChatGPTAccount = Omit<ChatGPTAccountCredential, 'refresh_token' | 'accessToken'> & {
  readonly refresh_token: Secret<string> | null;
  readonly accessToken: ChatGPTToken | null;
};
export type ChatGPTAccountFacts<O extends ChatGPTOperation = ChatGPTOperation> = ChatGPTRequest<O> & {
  'request.chatgpt.account': ChatGPTAccount;
};
export type ChatGPTAuthenticatedFacts<O extends ChatGPTOperation = ChatGPTOperation> = ChatGPTAccountFacts<O> & {
  'request.chatgpt.accessToken': ChatGPTToken;
  'request.chatgpt.plan': ChatGPTPlanObservation | null;
};
export interface ChatGPTHttpFacts extends HttpRequestFacts {
  'request.chatgpt.model': ProviderModelFacts;
  'request.chatgpt.account': ChatGPTAccount;
  'request.chatgpt.accessToken': ChatGPTToken;
  'request.chatgpt.plan': ChatGPTPlanObservation | null;
  'request.chatgpt.modelKey': string;
  'request.provider.modelKey': string;
}

export interface ChatGPTPipelineConfig {
  readonly upstreamId: string;
  readonly fallbackPlanType: string | undefined;
  readonly readAccount: () => Promise<ChatGPTAccountCredential>;
  readonly effects: ChatGPTCallEffects;
}

export const tokenFacts = (entry: ChatGPTAccessTokenEntry): ChatGPTToken => ({ ...entry, token: secret(entry.token) });
export const accountFacts = (account: ChatGPTAccountCredential): ChatGPTAccount => ({
  ...account,
  refresh_token: account.refresh_token === null ? null : secret(account.refresh_token),
  accessToken: account.accessToken === null ? null : tokenFacts(account.accessToken),
});
export const accountValue = (account: ChatGPTAccount): ChatGPTAccountCredential => ({
  ...account,
  refresh_token: account.refresh_token === null ? null : account.refresh_token.reveal(),
  accessToken: account.accessToken === null ? null : { ...account.accessToken, token: account.accessToken.token.reveal() },
});

export const chatgptCall = (
  config: ChatGPTPipelineConfig,
  facts: { 'request.chatgpt.account': ChatGPTAccount; 'request.http.callId': number },
  use: ProviderServices,
  model: ChatGPTBackendCallBase['model'],
): ChatGPTBackendCallBase => {
  const call = use.httpCall(facts['request.http.callId']);
  return {
    upstreamId: config.upstreamId,
    account: accountValue(facts['request.chatgpt.account']),
    model,
    headers: new Headers(),
    signal: call.signal,
    effects: config.effects,
    call: { ...call, headers: new Headers() },
  };
};
