import type { ControlPlaneModel } from '../../api/types';
import type { CatalogIndex } from '../models/catalog-index';
import {
  chatMetadataWithRules,
  intersectChatMetadata,
  type AliasTarget,
  type AnnouncedMetadata,
  type ChatModelInfo,
  type ModelKind,
  type PublicModelLimits,
} from '@floway-dev/protocols/common';

const effectiveChat = chatMetadataWithRules;
const intersectChat = intersectChatMetadata;

export const computeAnnouncedMetadata = (
  targets: readonly AliasTarget[],
  kind: ModelKind,
  catalog: CatalogIndex,
): AnnouncedMetadata => {
  const available = targets
    .map(target => ({ target, model: catalog.get(target.target_model_id) }))
    .filter((entry): entry is { target: AliasTarget; model: ControlPlaneModel } => entry.model?.kind === kind);
  if (!available.length) return {};
  const limits: PublicModelLimits = {};
  for (const key of ['max_context_window_tokens', 'max_prompt_tokens', 'max_output_tokens'] as const) {
    const values = available.map(({ model }) => model.limits[key]);
    if (values.every((value): value is number => value !== undefined)) limits[key] = Math.min(...values);
  }
  const out: AnnouncedMetadata = {};
  if (Object.keys(limits).length) out.limits = limits;
  const chats = available.map(({ target, model }) => effectiveChat(model.chat, target.rules));
  if (chats.every((chat): chat is ChatModelInfo => chat !== undefined)) out.chat = intersectChat(chats);
  return out;
};
