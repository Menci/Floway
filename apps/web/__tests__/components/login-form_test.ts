import { describe, expect, it } from 'vitest';

import { loginSchema } from '../../src/components/login-form';

describe('login schema', () => {
  it('allows zero-config default-admin login', () => {
    expect(loginSchema.safeParse({ username: '', password: '' }).success).toBe(true);
  });

  it('still requires a password for named users', () => {
    expect(loginSchema.safeParse({ username: 'operator', password: '' }).success).toBe(false);
  });
});
