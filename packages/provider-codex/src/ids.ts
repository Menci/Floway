// Format the SHA-256 digest as a UUIDv4-shaped opaque identifier. This remains
// for Floway-owned stable ids where we intentionally do not mimic Codex's
// random persisted device id yet.
export const sha256Uuid = async (input: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const hex = Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
  const variantNibble = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
