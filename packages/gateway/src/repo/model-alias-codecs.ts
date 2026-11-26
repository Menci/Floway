import type { AliasTarget, AnnouncedMetadata } from '@floway-dev/protocols/common';

const parseJson = <T>(raw: string, message: string): T => {
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new Error(message, { cause });
  }
};

export const decodeAliasTargets = (raw: string, id: string): AliasTarget[] =>
  parseJson<AliasTarget[]>(raw, `model_aliases.targets JSON is malformed for id=${id}`);

export const decodeAnnouncedMetadata = (raw: string, id: string): AnnouncedMetadata =>
  parseJson<AnnouncedMetadata>(raw, `model_aliases.announced_metadata_json JSON is malformed for id=${id}`);

export const encodeAliasTargets = (targets: readonly AliasTarget[]): string => JSON.stringify(targets);

export const encodeAnnouncedMetadata = (metadata: AnnouncedMetadata): string => JSON.stringify(metadata);
