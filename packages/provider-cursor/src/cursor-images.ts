/**
 * OpenAI image_url → Cursor SelectedImage parsing.
 *
 * Cursor carries input images as inline raw bytes on
 * UserMessage.selected_context.selected_images[] (proto SelectedImage: mime_type
 * + bytes data). Only base64 data: URLs are decoded here; remote http(s) URLs
 * are skipped (fetching them would add an SSRF surface — deferred). Limits match
 * Cursor's composer-api: at most MAX_CURSOR_IMAGES images, each ≤ MAX bytes.
 */

import type { ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';

export interface CursorImageInput {
  // Raw image bytes (decoded from a data: URL).
  data: Uint8Array;
  // e.g. "image/png" — goes to SelectedImage.mime_type.
  mimeType: string;
}

// Match Cursor's own composer-api input limits (per OmniRoute's capture).
export const MAX_CURSOR_IMAGE_BYTES = 1024 * 1024; // 1 MiB per image
export const MAX_CURSOR_IMAGES = 12;

const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s;

const decodeBase64 = (b64: string): Uint8Array | null => {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
};

/**
 * Extract data-URL images from a message's content parts, capped at
 * MAX_CURSOR_IMAGES and dropping any single image over MAX_CURSOR_IMAGE_BYTES.
 * Remote image_url entries are skipped (no SSRF-guarded fetch yet).
 */
export const parseCursorImages = (message: ChatCompletionsMessage): CursorImageInput[] => {
  const content = message.content;
  if (!Array.isArray(content)) return [];

  const out: CursorImageInput[] = [];
  for (const part of content) {
    if (part.type !== 'image_url') continue;
    if (out.length >= MAX_CURSOR_IMAGES) break;
    const match = DATA_URL_RE.exec(part.image_url.url);
    if (!match) continue; // remote URL — deferred
    const bytes = decodeBase64(match[2]!);
    if (!bytes || bytes.length === 0 || bytes.length > MAX_CURSOR_IMAGE_BYTES) continue;
    out.push({ data: bytes, mimeType: match[1]! });
  }
  return out;
};
