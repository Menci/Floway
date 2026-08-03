// index.html is prerendered from `HydrateFallback`, in the default language,
// and hydration has to reproduce it word for word or React rebuilds the
// document. Its spinner label is the one translated string in that file, so it
// is also the only one the app has to be able to render before a locale bundle
// has arrived. It ships with the shell and stays the source `locales/en.ts`
// reads, because two declarations of it could disagree and the disagreement
// would only ever show up as a hydration mismatch on a visitor's first paint.
export const shellLoadingLabel = 'Loading…';

export const shellResources = { translation: { common: { loading: shellLoadingLabel } } };
