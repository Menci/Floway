import { parseStoredJson } from './stored-json.ts';
import type { AliasTarget, AnnouncedMetadata } from '@floway-dev/protocols/common';

export const decodeAliasTargets = (raw: string, id: string): AliasTarget[] =>
  parseStoredJson<AliasTarget[]>(raw, `model_aliases.targets JSON is malformed for id=${id}`);

export const decodeAnnouncedMetadata = (raw: string, id: string): AnnouncedMetadata =>
  parseStoredJson<AnnouncedMetadata>(raw, `model_aliases.announced_metadata_json JSON is malformed for id=${id}`);

export const encodeAliasTargets = (targets: readonly AliasTarget[]): string => JSON.stringify(targets);

export const encodeAnnouncedMetadata = (metadata: AnnouncedMetadata): string => JSON.stringify(metadata);
