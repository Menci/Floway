import { mintChatGPTAccessToken } from './access-token.ts';
import { ChatGPTOAuthSessionTerminatedError } from './auth/oauth.ts';
import { assertChatGPTUpstreamRecord } from './config.ts';
import { CHATGPT_DEFAULT_FLAGS } from './defaults.ts';
import { chatgptImageProviderModel, chatgptPlanSupportsImages, chatgptRawToProviderModel, fetchChatGPTCatalog } from './models.ts';
import { ensureChatGPTAccessToken } from './service.ts';
import { persistChatGPTRefreshTokenRotation, persistChatGPTTerminalState } from './state.ts';
import { resolveEffectiveFlags, type Fetcher, type ProviderModel, type UpstreamRecord } from '@floway-dev/provider';

export const getChatGPTProvidedModels = async (record: UpstreamRecord, fetcher: Fetcher): Promise<ProviderModel[]> => {
  assertChatGPTUpstreamRecord(record);
  const { chatgptAccountId: accountId, planType } = record.config.accounts[0];
  const enabledFlags = resolveEffectiveFlags([CHATGPT_DEFAULT_FLAGS, record.flagOverrides]);
  let access;
  try {
    access = await ensureChatGPTAccessToken(record.id, accountId, refreshToken =>
      mintChatGPTAccessToken(refreshToken, fetcher, rotated => persistChatGPTRefreshTokenRotation(record.id, accountId, rotated, { onMissing: 'throw' })));
  } catch (error) {
    if (error instanceof ChatGPTOAuthSessionTerminatedError) {
      await persistChatGPTTerminalState(record.id, accountId, 'refresh_failed', error.upstreamMessage, { onMissing: 'throw' });
    }
    throw error;
  }
  const raw = await fetchChatGPTCatalog({ accessToken: access.token, accountId, fetcher });
  const models = raw.map(model => chatgptRawToProviderModel(model, enabledFlags));
  if (chatgptPlanSupportsImages(access.planType ?? planType ?? undefined)) models.push(chatgptImageProviderModel(enabledFlags));
  return models;
};
