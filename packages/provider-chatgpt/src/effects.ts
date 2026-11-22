import { persistChatGPTRefreshTokenRotation, persistChatGPTTerminalState } from './state.ts';

export interface ChatGPTStateEffects {
  persistRefreshTokenRotation(newRefreshToken: string): Promise<void>;
  persistTerminalState(state: 'session_terminated' | 'refresh_failed', message: string): Promise<void>;
}

export const chatgptStateEffects = (upstreamId: string, accountId: string | null): ChatGPTStateEffects => ({
  persistRefreshTokenRotation: refreshToken =>
    persistChatGPTRefreshTokenRotation(upstreamId, accountId, refreshToken, { onMissing: 'throw' }),
  persistTerminalState: (state, message) =>
    persistChatGPTTerminalState(upstreamId, accountId, state, message, { onMissing: 'throw' }),
});
