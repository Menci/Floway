import { decodeStoredJson } from './stored-json.ts';
import type { AliasTarget, AnnouncedMetadata } from '@floway-dev/protocols/common';
import { z } from 'zod';

const reasoningSchema = z.object({
  effort: z.string().optional(),
  budget_tokens: z.number().optional(),
  adaptive: z.boolean().optional(),
  summary: z.string().optional(),
}).passthrough();
const rulesSchema = z.object({
  reasoning: reasoningSchema.optional(),
  verbosity: z.string().optional(),
  serviceTier: z.string().optional(),
}).passthrough();
const aliasTargetsSchema = z.array(z.object({
  target_model_id: z.string(),
  rules: rulesSchema,
}).passthrough());

const limitsSchema = z.object({
  max_output_tokens: z.number().optional(),
  max_context_window_tokens: z.number().optional(),
  max_prompt_tokens: z.number().optional(),
}).passthrough();
const announcedMetadataSchema = z.object({
  limits: limitsSchema.optional(),
  chat: z.object({
    modalities: z.object({
      input: z.array(z.enum(['text', 'image'])),
      output: z.array(z.enum(['text', 'image'])),
    }).passthrough().optional(),
    reasoning: z.object({
      effort: z.object({ supported: z.array(z.string()), default: z.string() }).passthrough().optional(),
      budget_tokens: z.object({ min: z.number().optional(), max: z.number().optional() }).passthrough().optional(),
      adaptive: z.boolean().optional(),
      mandatory: z.boolean().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

const decodeAliasJson = <T>(raw: string, schema: z.ZodType<T>, field: string, id: string): T =>
  decodeStoredJson(raw, schema, {
    malformed: `model_aliases.${field} JSON is malformed for id=${id}`,
    invalid: `model_aliases.${field} JSON is invalid for id=${id}`,
  });

export const decodeAliasTargets = (raw: string, id: string): AliasTarget[] =>
  decodeAliasJson(raw, aliasTargetsSchema, 'targets', id);

export const decodeAnnouncedMetadata = (raw: string, id: string): AnnouncedMetadata =>
  decodeAliasJson(raw, announcedMetadataSchema, 'announced_metadata_json', id);

export const encodeAliasTargets = (targets: readonly AliasTarget[]): string => JSON.stringify(targets);

export const encodeAnnouncedMetadata = (metadata: AnnouncedMetadata): string => JSON.stringify(metadata);
