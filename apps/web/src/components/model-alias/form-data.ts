import type { InferRequestType } from 'hono/client';

import type { api } from '../../api/client';
import type { AliasSelection, AliasTarget, AnnouncedMetadata, ModelAlias, ModelKind } from '../../api/types';

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

export const metadataForKind = (
  kind: ModelKind,
  metadata: AnnouncedMetadata,
): AnnouncedMetadata => kind === 'chat'
  ? metadata
  : metadata.limits ? { limits: structuredClone(metadata.limits) } : {};

export function aliasDefaults(alias: ModelAlias | null): AliasFormValues {
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
}

// `sort_order` is left out in both directions: the server appends a new alias
// after the last one and preserves an existing one's place when the field is
// absent, and the dialog never reorders.
export function aliasBody(values: AliasFormValues): AliasWriteBody {
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
    announced_metadata: values.manualMetadata && values.kind !== 'image'
      ? structuredClone(values.announcedMetadata) as AliasWriteBody['announced_metadata']
      : null,
  };
}
