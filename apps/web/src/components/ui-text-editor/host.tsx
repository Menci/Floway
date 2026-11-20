import type { Theme } from '@fluentui/react-components';
import { lazy, Suspense, useSyncExternalStore } from 'react';

import { isUiTextEditorEnabled } from '../../i18n/ui-text-editor/mirror';

const LazyUiTextEditorOverlay = lazy(() => import('./overlay'));

const subscribeNever = () => () => {};
const isClient = () => true;
const isServer = () => false;

// Stays completely inert when the UI text editor is off: no overlay chunk is fetched
// and no markers are injected. When enabled, the lazy overlay starts its DOM
// observer before activating markers so the initial page needs no navigation
// and prerendered hydration stays byte-identical.
export function UiTextEditorHost({ theme }: { theme: Theme }) {
  const hydrated = useSyncExternalStore(subscribeNever, isClient, isServer);
  const enabled = isUiTextEditorEnabled();

  if (!enabled || !hydrated) return null;

  return (
    <Suspense fallback={null}>
      <LazyUiTextEditorOverlay theme={theme} />
    </Suspense>
  );
}
