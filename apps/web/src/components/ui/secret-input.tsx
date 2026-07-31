import { useState, type ComponentProps } from 'react';

import { Input } from './fluent-form-controls';

type InputProps = ComponentProps<typeof Input>;

// Password managers fill any empty password-typed field on load, silently
// replacing a credential the operator never touched. The standard opt-outs are
// advisory and each manager honours a different one, so the field additionally
// stays readOnly until the user actually reaches for it: an empty readOnly
// input is not a fill target, and the guard re-arms on blur if nothing was
// entered.
export const SecretInput = ({ onChange, revealed = false, value, ...rest }: InputProps & { revealed?: boolean }) => {
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
};
