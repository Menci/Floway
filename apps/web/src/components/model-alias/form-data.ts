import type { InferRequestType } from 'hono/client';

import type { api } from '../../api/client';
import type {
  AliasSelection,
  AliasTarget,
  AnnouncedMetadata,
  ModelAlias,
  ModelKind,
} from '@floway-dev/protocols/common';

type AliasWriteBody = InferRequestType<typeof api.api.aliases.$post>['json'];

export interface AliasFormValues {
  name: string;
  displayName: string;
  kind: ModelKind;
  selection: AliasSelection;
  visible: boolean;
  targets: AliasTarget[];
  manualMetadata: boolean;
  announcedMetadata: AnnouncedMetadata;
}

export const blankTarget = (): AliasTarget => ({ target_model_id: '', rules: {} });

// An image alias announces nothing: its /v1/models entry carries no limits and
// no chat block, so there is no operator override to hold.
export const kindAnnouncesMetadata = (kind: ModelKind): boolean => kind !== 'image';

export const metadataForKind = (
  kind: ModelKind,
  metadata: AnnouncedMetadata,
): AnnouncedMetadata => !kindAnnouncesMetadata(kind)
  ? {}
  : kind === 'chat'
    ? metadata
    : metadata.limits ? { limits: structuredClone(metadata.limits) } : {};

export const aliasDefaults = (alias: ModelAlias | null): AliasFormValues => {
  return alias ? {
    name: alias.name,
    displayName: alias.display_name ?? '',
    kind: alias.kind,
    selection: alias.selection,
    visible: alias.visible_in_models_list,
    targets: structuredClone(alias.targets),
    manualMetadata: alias.announced_metadata !== null,
    announcedMetadata: structuredClone(alias.announced_metadata ?? {}),
  } : {
    name: '', displayName: '', kind: 'chat', selection: 'first-available', visible: true,
    targets: [blankTarget()], manualMetadata: false, announcedMetadata: {},
  };
};

// `sort_order` is left out: absent, the server appends a new alias last and
// keeps an existing one's place.
export const aliasBody = (values: AliasFormValues): AliasWriteBody => {
  const trimRules = (rules: AliasTarget['rules']): AliasTarget['rules'] => {
    const reasoning = rules.reasoning ? Object.fromEntries(Object.entries(rules.reasoning).filter(([, value]) => value !== undefined && value !== '')) : undefined;
    return {
      ...(reasoning && Object.keys(reasoning).length ? { reasoning } : {}),
      ...(rules.verbosity ? { verbosity: rules.verbosity.trim() } : {}),
      ...(rules.serviceTier ? { serviceTier: rules.serviceTier.trim() } : {}),
    };
  };
  return {
    name: values.name.trim(), kind: values.kind, selection: values.selection,
    display_name: values.displayName.trim() || null,
    visible_in_models_list: values.visible,
    targets: values.targets.map(target => ({
      target_model_id: target.target_model_id.trim(),
      rules: values.kind === 'chat' ? { ...trimRules(target.rules) } : {},
    })),
    announced_metadata: values.manualMetadata && kindAnnouncesMetadata(values.kind)
      ? structuredClone(values.announcedMetadata) as AliasWriteBody['announced_metadata']
      : null,
  };
};
