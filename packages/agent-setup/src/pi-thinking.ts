import type { ChatModelInfo } from '@floway-dev/protocols/common';

// Pi's fixed UI slots are mapped to upstream-owned effort strings; null hides
// a slot, while an omitted slot would inherit Pi's native default.
// https://github.com/earendil-works/pi/blob/1cedd32724abfcb0915f76cc61b6827e2c16dbad/packages/ai/src/models.ts#L1222-L1255
export const piThinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type PiThinkingLevel = typeof piThinkingLevels[number];
export type PiThinkingLevelMap = Record<PiThinkingLevel, string | null>;
export type PiThinkingLevelMapResult = { supported: true; map: PiThinkingLevelMap } | { supported: false; message: string };

export const piThinkingLevelMap = (reasoning: ChatModelInfo['reasoning'], modelId: string): PiThinkingLevelMapResult => {
  const supported = reasoning?.effort?.supported ?? [];
  const map = Object.fromEntries(piThinkingLevels.map(level => [level, null])) as PiThinkingLevelMap;
  if (supported.length > 0) {
    const mandatory = reasoning!.mandatory === true;
    for (const level of piThinkingLevels) {
      if (level !== 'off' && supported.includes(level)) map[level] = level;
    }
    const custom = [...new Set(supported)].filter(level => (mandatory || (level !== 'none' && level !== 'off')) && (level === 'off' || !piThinkingLevels.includes(level as PiThinkingLevel)));
    const assignCustom = (value: string, preferred?: PiThinkingLevel): boolean => {
      const slot = preferred !== undefined && map[preferred] === null ? preferred : (['low', 'medium', 'high', 'minimal', 'xhigh', 'max'] as const).find(level => map[level] === null);
      if (slot === undefined) return false;
      map[slot] = value;
      return true;
    };
    const defaultEffort = reasoning!.effort!.default;
    if (custom.includes(defaultEffort) && !assignCustom(defaultEffort, 'medium')) return { supported: false, message: `Pi cannot represent all reasoning efforts for model ${modelId}` };
    for (const effort of custom) {
      if (effort !== defaultEffort && !assignCustom(effort)) return { supported: false, message: `Pi cannot represent all reasoning efforts for model ${modelId}` };
    }
    if (!mandatory) {
      if (supported.includes('none')) map.off = 'none';
      else if (supported.includes('off')) map.off = 'off';
    }
  } else if (reasoning?.budget_tokens !== undefined) {
    for (const level of ['minimal', 'low', 'medium', 'high'] as const) map[level] = level;
    if (reasoning.mandatory !== true) map.off = 'off';
  } else {
    if (reasoning?.adaptive === true) map.high = 'high';
    if (reasoning?.mandatory !== true) map.off = 'off';
  }
  return { supported: true, map };
};
