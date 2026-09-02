import { FAST_SERVICE_TIER } from '@floway-dev/protocols/common';
import type { MessagesPayload } from '@floway-dev/protocols/messages';

// Anthropic reaches the accelerated lane through `speed: 'fast'`, OpenAI
// through `service_tier` — `priority`, or its post-rename synonym `fast`. We
// emit `priority` because that is the spelling OpenAI reports back, so a
// request and the tier it is answered with read the same. Other non-fast
// `speed` values have no OpenAI equivalent and are dropped. When `speed` is
// absent, Anthropic's own `service_tier` passes through verbatim.
// https://docs.claude.com/en/build-with-claude/fast-mode
// https://platform.openai.com/docs/guides/fast-mode
export const openAIServiceTierFromMessages = (payload: Pick<MessagesPayload, 'speed' | 'service_tier'>): string | undefined =>
  payload.speed === 'fast' ? FAST_SERVICE_TIER : payload.speed === undefined ? payload.service_tier : undefined;
