const canonicalItemType = (itemType: string): string =>
  itemType === 'compaction_summary' ? 'compaction' : itemType;

// Egress `wrap` and ingress `unwrap` must derive an identical AEAD domain
// for authentication to succeed, so both sides share this one builder.
export const carrierDomain = (itemType: string, slot: string): string =>
  `responses.${canonicalItemType(itemType)}.${slot}`;
