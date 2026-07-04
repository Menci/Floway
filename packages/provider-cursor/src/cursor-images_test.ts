import { describe, expect, test } from 'vitest';

import { MAX_CURSOR_IMAGE_BYTES, MAX_CURSOR_IMAGES, parseCursorImages } from './cursor-images.ts';
import { encodeSelectedContext, encodeSelectedImage, encodeUserMessage } from './proto/agent-messages.ts';
import { AgentMode } from './proto/types.ts';
import { type ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';

// A 1x1 PNG (real base64) — small, valid bytes.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const dataUrl = (mime = 'image/png', b64 = PNG_B64) => `data:${mime};base64,${b64}`;
const userWith = (...parts: unknown[]): ChatCompletionsMessage => ({ role: 'user', content: parts } as unknown as ChatCompletionsMessage);
const imgPart = (url: string) => ({ type: 'image_url', image_url: { url } });

describe('parseCursorImages', () => {
  test('decodes a base64 data URL to bytes + mime', () => {
    const out = parseCursorImages(userWith({ type: 'text', text: 'hi' }, imgPart(dataUrl())));
    expect(out).toHaveLength(1);
    expect(out[0].mimeType).toBe('image/png');
    expect(out[0].data.length).toBeGreaterThan(0);
  });
  test('string content and non-image parts yield nothing', () => {
    expect(parseCursorImages({ role: 'user', content: 'plain' } as ChatCompletionsMessage)).toEqual([]);
    expect(parseCursorImages(userWith({ type: 'text', text: 'x' }))).toEqual([]);
  });
  test('remote http(s) URLs are skipped (deferred)', () => {
    expect(parseCursorImages(userWith(imgPart('https://example.com/a.png')))).toEqual([]);
  });
  test('malformed base64 is skipped', () => {
    expect(parseCursorImages(userWith(imgPart('data:image/png;base64,@@@not base64@@@')))).toEqual([]);
  });
  test('images over the byte cap are dropped', () => {
    const big = btoa('x'.repeat(MAX_CURSOR_IMAGE_BYTES + 10));
    expect(parseCursorImages(userWith(imgPart(dataUrl('image/png', big))))).toEqual([]);
  });
  test('caps the number of images', () => {
    const parts = Array.from({ length: MAX_CURSOR_IMAGES + 5 }, () => imgPart(dataUrl()));
    expect(parseCursorImages(userWith(...parts))).toHaveLength(MAX_CURSOR_IMAGES);
  });
});

// Wire-format helpers.
const has = (buf: Uint8Array, needle: Uint8Array): boolean => {
  outer: for (let i = 0; i + needle.length <= buf.length; i++) {
    for (let j = 0; j < needle.length; j++) if (buf[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};
const utf8 = (s: string) => new TextEncoder().encode(s);

describe('SelectedImage encoding', () => {
  const img = { data: new Uint8Array([1, 2, 3, 4, 5]), mimeType: 'image/jpeg' };

  test('encodeSelectedImage embeds mime_type and raw bytes', () => {
    const bytes = encodeSelectedImage(img);
    expect(has(bytes, utf8('image/jpeg'))).toBe(true);
    expect(has(bytes, img.data)).toBe(true);
    // field 7 (mime_type) tag = (7<<3)|2 = 0x3a; field 8 (data) tag = (8<<3)|2 = 0x42.
    expect(has(bytes, new Uint8Array([0x3a]))).toBe(true);
    expect(has(bytes, new Uint8Array([0x42]))).toBe(true);
  });

  test('encodeUserMessage attaches selected_context (field 3) only when images present', () => {
    const withImg = encodeUserMessage('hi', 'mid', AgentMode.AGENT, [img]);
    const without = encodeUserMessage('hi', 'mid', AgentMode.AGENT);
    // field 3 (selected_context) tag = (3<<3)|2 = 0x1a
    expect(has(withImg, new Uint8Array([0x1a]))).toBe(true);
    expect(has(without, new Uint8Array([0x1a]))).toBe(false);
    expect(has(withImg, img.data)).toBe(true);
    expect(withImg.length).toBeGreaterThan(without.length);
  });

  test('encodeSelectedContext repeats field 1 (selected_images) per image', () => {
    const one = encodeSelectedContext([img]);
    const two = encodeSelectedContext([img, img]);
    // field-1 (selected_images) tag = (1<<3)|2 = 0x0a
    expect(has(one, new Uint8Array([0x0a]))).toBe(true);
    expect(two.length).toBeGreaterThan(one.length);
  });
});
