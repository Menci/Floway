import type {
  MessagesAssistantMessage,
  MessagesPayload,
  MessagesServerToolUseBlock,
  MessagesTool,
  MessagesToolResultContentBlock,
  MessagesWebSearchResultBlock,
} from '../../src/messages/index.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export type ToolResultContentExcludesWebSearchResult = Expect<Equal<Extract<MessagesToolResultContentBlock, MessagesWebSearchResultBlock>, never>>;
export type ServerToolUseNameIsString = Expect<Equal<MessagesServerToolUseBlock['name'], string>>;
export type ServerToolUseInputIsQueryObject = Expect<Equal<MessagesServerToolUseBlock['input'], { query: string }>>;

export const clientTool = {
  name: 'get_weather',
  input_schema: { type: 'object' },
} satisfies MessagesTool;

export const nativeWebSearchTool = {
  type: 'web_search_20250305',
  max_uses: 3,
} satisfies MessagesTool;

export const fallbackHistory = [{
  role: 'assistant',
  content: [{ type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' }, trigger: null }],
}] satisfies MessagesAssistantMessage[];

export const futureThinkingDisplay = {
  model: 'claude-future',
  messages: [{ role: 'user', content: 'hello' }],
  max_tokens: 1,
  thinking: { type: 'adaptive', display: 'future-display-mode' },
} satisfies MessagesPayload;
