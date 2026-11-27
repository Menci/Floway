import { ensureChatGPTAccessToken, mintChatGPTAccessToken } from './access-token.ts';
import { ChatGPTOAuthSessionTerminatedError } from './auth/oauth.ts';
import { assertChatGPTUpstreamRecord } from './config.ts';
import { CHATGPT_DEFAULT_FLAGS } from './defaults.ts';
import { chatgptImageUpstreamModel, chatgptPlanSupportsImages, chatgptRawToUpstreamModel, fetchChatGPTCatalog } from './models.ts';
import { assertChatGPTUpstreamState, persistChatGPTRefreshTokenRotation, persistChatGPTTerminalState } from './state.ts';
import { resolveEffectiveFlags, type Fetcher, type UpstreamModel, type UpstreamRecord } from '@floway-dev/upstream';

export const getChatGPTModels = async (record: UpstreamRecord, fetcher: Fetcher): Promise<UpstreamModel[]> => {
  assertChatGPTUpstreamRecord(record);
  assertChatGPTUpstreamState(record.state);
  const { chatgptAccountId: accountId, planType } = record.config.accounts[0];
  let access;
  try {
    access = await ensureChatGPTAccessToken(record.id, accountId, refreshToken =>
      mintChatGPTAccessToken(refreshToken, fetcher, token =>
        persistChatGPTRefreshTokenRotation(record.id, accountId, token, { onMissing: 'throw' })));
  } catch (error) {
    if (error instanceof ChatGPTOAuthSessionTerminatedError) {
      await persistChatGPTTerminalState(record.id, accountId, 'refresh_failed', error.upstreamMessage, { onMissing: 'throw' });
    }
    throw error;
  }

  const flags = resolveEffectiveFlags([CHATGPT_DEFAULT_FLAGS, record.flagOverrides]);
  const raw = await fetchChatGPTCatalog({ accessToken: access.token, accountId, fetcher });
  // The gateway allows operators to route to Codex models hidden in its UI.
  const models = raw.map(entry => chatgptRawToUpstreamModel(entry, flags));
  if (chatgptPlanSupportsImages(access.planType ?? planType ?? undefined)) models.push(chatgptImageUpstreamModel(flags));
  return models;
};
