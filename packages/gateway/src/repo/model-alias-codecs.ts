import { z } from 'zod';

import { decodeStoredJsonPreservingProperties } from './stored-json.ts';
import { MODEL_ALIAS_TARGET_LIMIT } from '../shared/model-aliases.ts';
import type { AliasTarget, AnnouncedMetadata } from '@floway-dev/protocols/common';

const reasoningSchema = z.object({
  effort: z.string().min(1).optional(),
  budget_tokens: z.number().int().nonnegative().optional(),
  adaptive: z.boolean().optional(),
  summary: z.string().min(1).optional(),
}).passthrough().refine(
  reasoning => !(reasoning.adaptive === true && reasoning.budget_tokens !== undefined),
  { message: 'adaptive=true cannot be combined with budget_tokens', path: ['budget_tokens'] },
);
const rulesSchema = z.object({
  reasoning: reasoningSchema.optional(),
  verbosity: z.string().min(1).optional(),
  serviceTier: z.string().min(1).optional(),
}).passthrough();
const aliasTargetsSchema = z.array(z.object({
  target_model_id: z.string().min(1),
  rules: rulesSchema,
}).passthrough()).min(1).max(MODEL_ALIAS_TARGET_LIMIT);

const limitsSchema = z.object({
  max_output_tokens: z.number().optional(),
  max_context_window_tokens: z.number().optional(),
  max_prompt_tokens: z.number().optional(),
}).passthrough();

const modalityArraySchema = z.array(z.enum(['text', 'image']))
  .min(1)
  .refine(modalities => new Set(modalities).size === modalities.length, 'modalities must not contain duplicates');

const effortSchema = z.object({
  supported: z.array(z.string().min(1))
    .min(1)
    .refine(efforts => new Set(efforts).size === efforts.length, 'effort.supported must not contain duplicates'),
  default: z.string().min(1),
}).passthrough().refine(
  effort => effort.supported.includes(effort.default),
  'effort.default must appear in effort.supported',
);

const budgetTokensSchema = z.object({
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().nonnegative().optional(),
}).passthrough().refine(
  budget => budget.min === undefined || budget.max === undefined || budget.max >= budget.min,
  'budget_tokens.max must be >= budget_tokens.min',
);

const metadataReasoningSchema = z.object({
  effort: effortSchema.optional(),
  budget_tokens: budgetTokensSchema.optional(),
  adaptive: z.literal(true).optional(),
  mandatory: z.literal(true).optional(),
}).passthrough().refine(
  reasoning => Object.keys(reasoning).length > 0,
  'reasoning must not be empty',
);

const announcedMetadataSchema = z.object({
  limits: limitsSchema.optional(),
  chat: z.object({
    modalities: z.object({
      input: modalityArraySchema.refine(modalities => modalities.includes('text'), "input modalities must include 'text'"),
      output: modalityArraySchema,
    }).passthrough().optional(),
    reasoning: metadataReasoningSchema.optional(),
  }).passthrough().optional(),
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
