import type { i18n as I18n } from 'i18next';
import type { ComponentProps, ReactElement } from 'react';
import { Trans as I18nextTrans, useTranslation as useI18nextTranslation } from 'react-i18next';

import type { NumberFormat } from './number-format';

// React consumers reach react-i18next's hooks and component through this
// module; initialization remains in ./index. `alwaysFormat` sends every
// interpolation through ./number-format, which throws on a number that names
// no format. That throw happens during render, so a bare `{{seconds}}` handed a
// number takes the whole route down to the error boundary. react-i18next types
// interpolation values as `unknown`, so nothing before the browser could see
// it coming.
//
// Everything below derives what a key needs from the English strings
// themselves. `locales/en` is `as const`, so each string survives into the type
// system as a literal, and the placeholders in it are parsed there: a bare
// `{{name}}` takes a string, `{{name, format}}` takes a number, and the set of
// format names comes from ./number-format's own table. Nothing here is
// maintained by hand, so a string and its call site cannot disagree.

type Translation = typeof import('./locales/en').default['translation'];

// The locale is a tree of nested objects; a key is the path to a string in it.
// Carrying the string alongside its key is what lets the map below recover it
// without walking the tree a second time.
type Leaf<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? { key: `${Prefix}${K}`; text: T[K] }
    : Leaf<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

// Flattening the union into one object type up front is what keeps this
// affordable: every later lookup is an indexed access into a resolved map
// rather than an `Extract` that re-scans a thousand-member union per call site.
type Texts = { [E in Leaf<Translation> as E['key']]: E['text'] };

// i18next resolves `foo` to `foo_one` / `foo_other` from `count`, so the base
// is a key the dashboard may ask for even though no string is stored under it.
// The `other` form is the one every language has, and the parity suite requires
// it, so it is the form the values are read from.
// https://www.unicode.org/reports/tr35/tr35-numbers.html#Language_Plural_Rules
type PluralBase<K> = K extends `${infer Base}_other` ? Base : never;

type PluralKey = PluralBase<keyof Texts>;

export type TranslationKey = keyof Texts | PluralKey;

// One entry per `{{…}}` in the string. The scan is left to right: the head
// swallows everything up to the first `{{`, the body runs to the first `}}`,
// and the tail is scanned again.
type Interpolations<S> = S extends `${string}{{${infer Body}}}${infer Rest}`
  ? Interpolation<Body> | Interpolations<Rest>
  : never;

type Interpolation<Body extends string> = Body extends `${infer Name}, ${infer Format}`
  ? { name: Name; value: Format extends NumberFormat ? number : never }
  : { name: Body; value: string };

type ValuesOf<S> = { [E in Interpolations<S> as E['name']]: E['value'] };

type ValuesFor<K> = K extends keyof Texts
  ? ValuesOf<Texts[K]>
  : `${K & string}_other` extends keyof Texts
    ? ValuesOf<Texts[`${K & string}_other`]> & { count: number }
    : never;

// Schema and server messages can carry a key whose type is only `string`. Its
// resource and values are unknowable here, so that genuinely dynamic boundary
// remains permissive. A non-catalogue literal is still rejected as a typo.
type IsDynamicKey<K> = string extends K ? true : false;
type AcceptedKey<K extends string> = K extends TranslationKey
  ? K
  : IsDynamicKey<K> extends true ? K : never;

type UnionToIntersection<U> = (
  U extends unknown ? (value: U) => void : never
) extends (value: infer I) => void ? I : never;

// A template key whose expression is a union of literals resolves to a union of
// keys, and the strings behind them need not agree on what they interpolate.
// A caller cannot correlate two separate function arguments, so the values
// object satisfies every possible member. A branch with no placeholders adds
// an empty object; incompatible requirements correctly make the call
// impossible until the caller narrows the key.
type ValuesArgument<K> = UnionToIntersection<K extends unknown ? ValuesFor<K> : never>;
type RequiresValues<K> = keyof ValuesArgument<K> extends never ? false : true;

// i18next also accepts a plain string second argument as the fallback text for
// a key with no string behind it. It is only offered where the key needs no
// values, since the two cannot be passed together.
type Arguments<K> = IsDynamicKey<K> extends true
  ? [values?: Record<string, unknown> | string]
  : RequiresValues<K> extends true
    ? [values: ValuesArgument<K>]
    : [values?: string];

export interface TFunction {
  <const K extends string>(key: AcceptedKey<K>, ...values: Arguments<K>): string;
}

// react-i18next types `t` from its own resource declarations, which the
// dashboard does not register; the two signatures describe the same runtime
// function and are not assignable in either direction.
export const useTranslation = (): { t: TFunction; i18n: I18n } => {
  const { t, i18n } = useI18nextTranslation();
  return { t: t as unknown as TFunction, i18n };
};

type TransMemberValues<K> = K extends PluralKey ? Omit<ValuesFor<K>, 'count'> : ValuesFor<K>;
type TransValuesArgument<K> = UnionToIntersection<K extends unknown ? TransMemberValues<K> : never>;
type TransValues<K> = keyof TransValuesArgument<K> extends never
  ? { values?: undefined }
  : { values: TransValuesArgument<K> };

type IsPlural<K> = K extends PluralKey ? true : false;
type TransCount<K> = true extends (K extends unknown ? IsPlural<K> : never)
  ? { count: number }
  : { count?: never };

type TransProps<K extends TranslationKey> = {
  i18nKey: K;
  components?: ComponentProps<typeof I18nextTrans>['components'];
} & TransCount<K> & TransValues<K>;

export const Trans = <const K extends TranslationKey>(props: TransProps<K>): ReactElement =>
  <I18nextTrans {...props as ComponentProps<typeof I18nextTrans>} />;
