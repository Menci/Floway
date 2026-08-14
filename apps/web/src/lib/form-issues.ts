import { useCallback } from 'react';

import { useTranslation } from '../i18n/translation';

// A domain validator is keyed by its own field vocabulary, which is not always a
// path in the form values, so react-hook-form nests the schema's issues under
// names its `FieldErrors` type does not know. Reading them back by that
// vocabulary is what keeps the schema the only validator while the editor keeps
// its own field names.
export const issuesFromErrors = <Field extends string>(
  errors: unknown,
  fields: readonly Field[],
): Partial<Record<Field, string>> => {
  const nested = errors as Partial<Record<Field, { message?: string }>> | undefined;
  if (nested === undefined) return {};
  return Object.fromEntries(fields.flatMap(field => {
    const message = nested[field]?.message;
    return message === undefined ? [] : [[field, message] as const];
  })) as Partial<Record<Field, string>>;
};

// A schema message is an i18n key when the catalogue has one, and otherwise text
// a parser produced about what the operator typed.
export const useIssueText = () => {
  const { i18n, t } = useTranslation();
  return useCallback(
    (message: string | undefined) => {
      if (message === undefined || !i18n.exists(message)) return message;
      const key: string = message;
      return t(key);
    },
    [i18n, t],
  );
};
