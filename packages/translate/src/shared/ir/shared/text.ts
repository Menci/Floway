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
    if (replacement) pending = pending.filter(entry => JSON.stringify(entry.path) !== key);
    pending.push({ path, text: replacement ? text : text.slice(old.length), start: replacement ? 0 : old.length, replacement });
    previous.set(key, text);
  };
  const update = (state: IR): void => {
    const current = new Set<string>();
    const visit = (path: IRPath, text: string): void => { current.add(JSON.stringify(path)); observe(path, text); };
    state.choices.forEach((choice, c) => choice.items.forEach((item, i) => {
      const path: IRPath = ['choices', c, 'items', i];
      if (item.type === 'reasoning') {
        for (const field of ['summary', 'content'] as const) item[field]?.forEach((text, p) => visit([...path, field, p], text));
      } else if (item.type === 'message') item.content.forEach((part, p) => {
        const source = [...path, 'content', p];
        if (part.type === 'text') visit([...source, 'text'], part.text);
        else if (part.type === 'refusal') visit([...source, 'refusal'], part.refusal);
        else if (part.type === 'audio' && part.audio.transcript !== undefined) visit([...source, 'audio', 'transcript'], part.audio.transcript);
      });
    }));
    for (const key of previous.keys()) if (!current.has(key)) previous.delete(key);
    pending = pending.filter(entry => current.has(JSON.stringify(entry.path)));
  };
  const takeMatching = (matches: (update: IRTextUpdate) => boolean): IRTextUpdate[] => {
    const selected: IRTextUpdate[] = [];
    const remaining: IRTextUpdate[] = [];
    for (const entry of pending) (matches(entry) ? selected : remaining).push(entry);
    pending = remaining;
    return selected;
  };
  const take = (prefix: IRPath): IRTextUpdate[] => takeMatching(entry => prefix.every((key, index) => entry.path[index] === key));
  return { update, take, takeMatching };
};
