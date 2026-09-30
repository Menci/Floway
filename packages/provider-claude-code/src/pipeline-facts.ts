import type { EnsuredAccessToken } from './access-token.ts';
import type { ClaudeCodeAccountCredential } from './state.ts';
import type { HttpRequestFacts } from '@floway-dev/http/pipeline';
import type { Secret } from '@floway-dev/pipeline';
import type { ProviderModelFacts, ProviderOperationRequest } from '@floway-dev/provider';

export type ClaudeCodeRequest = ProviderOperationRequest<'anthropicMessages'>;
export type ClaudeCodeAccountFacts = Omit<ClaudeCodeAccountCredential, 'refreshToken' | 'accessToken'> & {
  readonly refreshToken: Secret<string> | null;
  readonly accessToken: (Omit<NonNullable<ClaudeCodeAccountCredential['accessToken']>, 'token'> & { readonly token: Secret<string> }) | null;
};
export type ClaudeCodeAccessFacts = Omit<EnsuredAccessToken, 'entry'> & { readonly entry: Omit<EnsuredAccessToken['entry'], 'token'> & { readonly token: Secret<string> } };
export interface ClaudeCodePreparedRequest extends ClaudeCodeRequest {
  'request.provider.modelKey': string;
  'request.claudeCode.shaped': boolean;
}
export interface ClaudeCodeAuthenticatedRequest extends ClaudeCodePreparedRequest {
  'request.claudeCode.account': ClaudeCodeAccountFacts;
  'request.claudeCode.access': ClaudeCodeAccessFacts;
}
export interface ClaudeCodeHttpRequest extends HttpRequestFacts {
  'request.provider.modelKey': string;
  'request.claudeCode.model': ProviderModelFacts;
  'request.claudeCode.account': ClaudeCodeAccountFacts;
  'request.claudeCode.access': ClaudeCodeAccessFacts;
}
