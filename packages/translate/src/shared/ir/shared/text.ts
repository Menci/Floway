import type { IR } from '../ir.ts';
import type { IRPath } from '../stream.ts';

export interface IRTextUpdate { path: IRPath; text: string; start: number; replacement: boolean }

export const createIRTextStream = () => {
  const previous = new Map<string, string>();
  let pending: IRTextUpdate[] = [];
  const observe = (path: IRPath, text: string): void => {
    const key = JSON.stringify(path);
    const old = previous.get(key) ?? '';
    if (text === old) return;
    const replacement = !text.startsWith(old);
    pending.push({ path, text: replacement ? text : text.slice(old.length), start: replacement ? 0 : old.length, replacement });
    previous.set(key, text);
  };
  const update = (state: IR): void => {
    state.choices.forEach((choice, c) => choice.items.forEach((item, i) => {
      const path: IRPath = ['choices', c, 'items', i];
      if (item.type === 'reasoning') {
        for (const field of ['summary', 'content'] as const) item[field]?.forEach((text, p) => observe([...path, field, p], text));
      } else if (item.type === 'message') item.content.forEach((part, p) => {
        const source = [...path, 'content', p];
        if (part.type === 'text') observe([...source, 'text'], part.text);
        else if (part.type === 'refusal') observe([...source, 'refusal'], part.refusal);
        else if (part.type === 'audio' && part.audio.transcript !== undefined) observe([...source, 'audio', 'transcript'], part.audio.transcript);
      });
    }));
  };
  const take = (prefix: IRPath): IRTextUpdate[] => {
    const selected: IRTextUpdate[] = [];
    const remaining: IRTextUpdate[] = [];
    for (const entry of pending) (prefix.every((key, index) => entry.path[index] === key) ? selected : remaining).push(entry);
    pending = remaining;
    return selected;
  };
  return { update, take };
};
