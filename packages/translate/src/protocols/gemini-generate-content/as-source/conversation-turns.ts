import type { GeminiGenerateContentContent } from '@floway-dev/protocols/gemini-generate-content';

export type GeminiGenerateContentConversationTurn = { role: 'assistant' | 'bare'; items: GeminiGenerateContentContent[] };

export const partitionGeminiGenerateContentTurns = (contents: readonly GeminiGenerateContentContent[]): GeminiGenerateContentConversationTurn[] => {
  const turns: GeminiGenerateContentConversationTurn[] = [];
  for (const content of contents) {
    const role = content.role === 'model' ? 'assistant' : 'bare';
    const previous = turns.at(-1);
    if (previous?.role === role) previous.items.push(content);
    else turns.push({ role, items: [content] });
  }
  return turns;
};
