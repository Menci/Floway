import { mintChatGPTAccessToken } from './access-token.ts';
import { ChatGPTOAuthSessionTerminatedError } from './auth/oauth.ts';
import { assertChatGPTUpstreamRecord } from './config.ts';
import { CHATGPT_DEFAULT_FLAGS } from './defaults.ts';
import { chatgptImageProviderModel, chatgptPlanSupportsImages, chatgptRawToProviderModel, fetchChatGPTCatalog } from './models.ts';
import { ensureChatGPTAccessToken, type ChatGPTService } from './service.ts';
import { persistChatGPTRefreshTokenRotation, persistChatGPTTerminalState } from './state.ts';
import { resolveEffectiveFlags, type Fetcher, type ProviderModel, type UpstreamRecord } from '@floway-dev/provider';

export const getChatGPTProvidedModels = async (record: UpstreamRecord, fetcher: Fetcher, service: ChatGPTService): Promise<ProviderModel[]> => {
  assertChatGPTUpstreamRecord(record);
  const { chatgptAccountId: accountId, planType } = record.config.accounts[0];
  let access;
  try {
    access = await ensureChatGPTAccessToken(service, record.id, accountId, token =>
      mintChatGPTAccessToken(token, fetcher, rotated =>
        persistChatGPTRefreshTokenRotation(record.id, accountId, rotated, { onMissing: 'throw' })));
  } catch (error) {
    if (error instanceof ChatGPTOAuthSessionTerminatedError) {
      await persistChatGPTTerminalState(record.id, accountId, 'refresh_failed', error.upstreamMessage, { onMissing: 'throw' });
    }
    throw error;
  }

  const raw = await fetchChatGPTCatalog({ accessToken: access.token, accountId, fetcher });
  const enabledFlags = resolveEffectiveFlags([CHATGPT_DEFAULT_FLAGS, record.flagOverrides]);
  const models = raw.map(entry => chatgptRawToProviderModel(entry, enabledFlags));
  if (chatgptPlanSupportsImages(access.planType ?? planType ?? undefined)) models.push(chatgptImageProviderModel(enabledFlags));
  return models;
};
