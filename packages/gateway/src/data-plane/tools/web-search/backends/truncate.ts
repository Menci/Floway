// Cuts `content` to at most `maxBytes` UTF-8 bytes at a codepoint
// boundary. Walks back over continuation bytes (0x80-0xBF) so the cut
// never lands mid-codepoint.

export const truncateUtf8 = (content: string, maxBytes: number): { content: string; truncated: boolean; fullContentBytes: number } => {
  const bytes = new TextEncoder().encode(content);
  if (bytes.length <= maxBytes) return { content, truncated: false, fullContentBytes: bytes.length };

  let cut = maxBytes;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) cut -= 1;

  return {
    content: new TextDecoder().decode(bytes.subarray(0, cut)),
    truncated: true,
    fullContentBytes: bytes.length,
  };
};
