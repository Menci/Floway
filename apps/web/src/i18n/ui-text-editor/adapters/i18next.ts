import type { PostProcessorModule } from 'i18next';

import { defaultKeyMarkerChannel, type KeyMarkerChannel } from '../core/markers';

interface ResolvedInfo {
  exactUsedKey?: string;
  usedKey?: string;
}

export interface I18nextPostProcessorOptions {
  name: string;
  channel?: KeyMarkerChannel;
}

export const createI18nextKeyMarkerPostProcessor = (
  { channel = defaultKeyMarkerChannel, name }: I18nextPostProcessorOptions,
): PostProcessorModule => ({
  type: 'postProcessor',
  name,
  process(value, key, options) {
    if (!channel.isTrackingActive() || channel.isSuppressed()) return value;
    if (value.length === 0) return value;
    const opt = options as { i18nResolved?: ResolvedInfo } | undefined;
    const exactKey = opt?.i18nResolved?.exactUsedKey ?? opt?.i18nResolved?.usedKey ?? (Array.isArray(key) ? key[0] : key);
    if (!exactKey) return value;
    return channel.wrap(value, exactKey);
  },
});
