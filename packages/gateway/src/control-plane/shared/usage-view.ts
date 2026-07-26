import { type AuthedContext, userFromContext } from '../../middleware/auth.ts';

// The two shapes the usage endpoints answer in.
type UsageView = 'all-by-user' | 'self-by-key';

// Discriminated union so callers narrow scopeUserId without non-null assertions.
type ResolvedUsageView =
  | { view: 'self-by-key'; scopeUserId: number }
  | { view: 'all-by-user' };

export const resolveUsageView = (
  c: AuthedContext,
  view: UsageView,
  rawKeyId: string | undefined,
): ResolvedUsageView | { error: 'forbidden' | 'bad_request'; message: string } => {
  const user = userFromContext(c);

  if (view === 'self-by-key') return { view: 'self-by-key', scopeUserId: user.id };

  // Cross-user usage exposes other users' request volume and spend.
  if (!user.isAdmin) {
    return {
      error: 'forbidden',
      message: 'Viewing usage across users requires administrator privileges',
    };
  }
  if (rawKeyId !== undefined && rawKeyId !== '') {
    return {
      error: 'bad_request',
      message: 'key_id is not allowed in all-by-user mode',
    };
  }
  return { view: 'all-by-user' };
};
