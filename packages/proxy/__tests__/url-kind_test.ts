import { describe, expect, it } from 'vitest';

import { kindFromUri } from '../src/url-kind.ts';

describe('kindFromUri', () => {
  it('discriminates SS-2022 from legacy SS via the literal cipher prefix', () => {
    expect(kindFromUri('ss://2022-blake3-aes-128-gcm:k@h:8388')).toBe('SS-2022');
    expect(kindFromUri('ss://YWVzLTEyOC1nY206cA==@h:8388')).toBe('SS');
  });

  it('routes vless to REALITY / VLESS-WS / VLESS by query parameters', () => {
    expect(kindFromUri('vless://u@h:443?type=tcp&security=reality')).toBe('REALITY');
    expect(kindFromUri('vless://u@h:443?type=ws&security=tls')).toBe('VLESS-WS');
    expect(kindFromUri('vless://u@h:443?type=tcp&security=tls')).toBe('VLESS');
  });

  it('returns PROXY for inputs the URL constructor rejects (function is total)', () => {
    expect(kindFromUri('')).toBe('PROXY');
    expect(kindFromUri('not-a-url')).toBe('PROXY');
    expect(kindFromUri('http://')).toBe('PROXY');
  });
});
