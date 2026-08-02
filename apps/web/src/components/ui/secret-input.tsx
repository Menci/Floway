import { useState, type ComponentProps } from 'react';

import { Input } from './fluent-form-controls';

type InputProps = ComponentProps<typeof Input>;

// Password managers overwrite any empty password-typed field on load, and the
// opt-out attributes are advisory — each manager honours a different one. The
// field additionally stays readOnly, which is not a fill target, until the user
// reaches for it, re-arming on blur while still empty.
export function SecretInput({ onChange, revealed = false, value, ...rest }: InputProps & { revealed?: boolean }) {
  const [guardLocked, setGuardLocked] = useState(true);
  const hasValue = String(value ?? '').length > 0;
  const unlock = () => setGuardLocked(false);

  return <Input
    {...rest}
    autoCapitalize="off"
    autoComplete="new-password"
    autoCorrect="off"
    data-1p-ignore="true"
    data-bwignore="true"
    data-form-type="other"
    data-lpignore="true"
    onBlur={event => {
      if (!hasValue) setGuardLocked(true);
      rest.onBlur?.(event);
    }}
    onChange={onChange}
    onFocus={event => {
      unlock();
      rest.onFocus?.(event);
    }}
    onKeyDown={event => {
      unlock();
      rest.onKeyDown?.(event);
    }}
    onPaste={event => {
      unlock();
      rest.onPaste?.(event);
    }}
    onPointerDown={event => {
      unlock();
      rest.onPointerDown?.(event);
    }}
    readOnly={rest.readOnly ?? (!rest.disabled && guardLocked && !hasValue)}
    spellCheck={false}
    type={revealed ? 'text' : 'password'}
    value={value}
  />;
}
