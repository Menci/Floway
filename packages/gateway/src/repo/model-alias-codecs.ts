import { z } from 'zod';

import { decodeStoredJsonPreservingProperties } from './stored-json.ts';
import type { AliasTarget, AnnouncedMetadata } from '@floway-dev/protocols/common';

const reasoningSchema = z.object({
  effort: z.string().exactOptional(),
  budget_tokens: z.number().exactOptional(),
  adaptive: z.boolean().exactOptional(),
  summary: z.string().exactOptional(),
}).passthrough();
const rulesSchema = z.object({
  reasoning: reasoningSchema.exactOptional(),
  verbosity: z.string().exactOptional(),
  serviceTier: z.string().exactOptional(),
}).passthrough();
const aliasTargetsSchema = z.array(z.object({
  target_model_id: z.string(),
  rules: rulesSchema,
}).passthrough());

const limitsSchema = z.object({
  max_output_tokens: z.number().exactOptional(),
  max_context_window_tokens: z.number().exactOptional(),
  max_prompt_tokens: z.number().exactOptional(),
}).passthrough();
const announcedMetadataSchema = z.object({
  limits: limitsSchema.exactOptional(),
  chat: z.object({
    modalities: z.object({
      input: z.array(z.enum(['text', 'image', 'audio'])),
      output: z.array(z.enum(['text', 'image'])),
    }).passthrough().exactOptional(),
    image_detail_original: z.boolean().exactOptional(),
    reasoning: z.object({
      effort: z.object({ supported: z.array(z.string()), default: z.string() }).passthrough().exactOptional(),
      budget_tokens: z.object({ min: z.number().exactOptional(), max: z.number().exactOptional() }).passthrough().exactOptional(),
      adaptive: z.boolean().exactOptional(),
      mandatory: z.boolean().exactOptional(),
    }).passthrough().exactOptional(),
  }).passthrough().exactOptional(),
}).passthrough();

const decodeAliasJson = <T>(raw: string, schema: z.ZodType<T>, field: string, id: string): T =>
  decodeStoredJsonPreservingProperties(raw, schema, {
    malformed: `model_aliases.${field} JSON is malformed for id=${id}`,
    invalid: `model_aliases.${field} JSON is invalid for id=${id}`,
  });

export const decodeAliasTargets = (raw: string, id: string): AliasTarget[] =>
  decodeAliasJson(raw, aliasTargetsSchema, 'targets', id);

export const decodeAnnouncedMetadata = (raw: string, id: string): AnnouncedMetadata =>
  decodeAliasJson(raw, announcedMetadataSchema, 'announced_metadata_json', id);

export const encodeAliasTargets = (targets: readonly AliasTarget[]): string => JSON.stringify(targets);

export const encodeAnnouncedMetadata = (metadata: AnnouncedMetadata): string => JSON.stringify(metadata);
