import type { GeminiGenerateContentContent } from '@floway-dev/protocols/gemini-generate-content';

export type GeminiGenerateContentInputAssistantTurn = Array<Omit<GeminiGenerateContentContent, 'role'> & { role: 'model' }>;
