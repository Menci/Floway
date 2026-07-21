// Copilot-only Responses workarounds. The chain is a boundary the Copilot
// provider runs inside its own `callX` methods, so the gateway main flow
// never knows that Copilot has Responses interceptors at all.

import { withToolArgumentWhitespaceAborted } from './abort-on-tool-argument-whitespace.ts';
import { withInlineImagesCompressed } from './compress-images.ts';
import { withStoreForcedFalse } from './force-store-false.ts';
import { withCopilotResponsesItemIdMembrane } from './item-id-membrane.ts';
import { withInitiatorHeaderSet } from './set-initiator-header.ts';
import { withVisionHeaderSet } from './set-vision-header.ts';
import { withImageGenerationStripped } from './strip-image-generation.ts';
import { withServiceTierStripped } from './strip-service-tier.ts';
import type { CopilotResponsesBoundaryInterceptor } from './types.ts';

// Single chain wraps both the streaming `/responses` call and the
// non-streaming synth-via-trigger compaction call — the chain terminal
// switches on `ctx.action` to pick the wire shape. Order matters:
// payload-mutating interceptors run first so the header interceptors see
// the final outgoing payload, then the header interceptors populate
// `ctx.headers` for the upstream call. Result mutators sit between: the
// whitespace guard acts only on generate streams, while the item-id membrane
// also normalizes the generated item in compact value envelopes.
export const COPILOT_RESPONSES_BOUNDARY = [
  withInlineImagesCompressed,
  withServiceTierStripped,
  withImageGenerationStripped,
  withStoreForcedFalse,
  withCopilotResponsesItemIdMembrane,
  withToolArgumentWhitespaceAborted,
  withVisionHeaderSet,
  withInitiatorHeaderSet,
] as const satisfies readonly CopilotResponsesBoundaryInterceptor[];
