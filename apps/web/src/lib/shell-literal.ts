// POSIX and PowerShell single-quoted literal encoders. The Agent Setup card
// embeds the dashboard's own `window.location.origin` — an external boundary —
// into the copyable setup commands, so it is always emitted through one of these
// rather than concatenated raw: a value carrying quotes or shell metacharacters
// cannot then break out of its assignment. A URL origin cannot contain a quote
// or NUL by the URL grammar, but the encoders stay general so the same rule
// covers any value and the guarantee is the encoder's, not the caller's.

const assertNoNul = (value: string): void => {
  if (value.includes('\0')) throw new Error('cannot encode a value containing a NUL character');
};

// POSIX single-quoted word: everything inside single quotes is literal except
// the single quote itself, which is closed, backslash-escaped, and reopened.
export const posixShellLiteral = (value: string): string => {
  assertNoNul(value);
  return `'${value.replace(/'/g, "'\\''")}'`;
};

// PowerShell single-quoted string: the single quote is the only escape and is
// doubled; every other character is literal.
export const powerShellLiteral = (value: string): string => {
  assertNoNul(value);
  return `'${value.replace(/'/g, "''")}'`;
};
