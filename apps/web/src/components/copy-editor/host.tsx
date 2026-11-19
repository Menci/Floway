import type { Theme } from '@fluentui/react-components';
import { lazy, Suspense, useSyncExternalStore } from 'react';

import { isCopyEditorEnabled } from '../../i18n/copy-editor/mirror';

const LazyCopyEditorOverlay = lazy(() => import('./overlay'));

const subscribeNever = () => () => {};
const isClient = () => true;
const isServer = () => false;

// Stays completely inert when copy editing is off: no overlay chunk is fetched
// and no markers are injected. When enabled, the lazy overlay starts its DOM
// observer before activating markers so the initial page needs no navigation
// and prerendered hydration stays byte-identical.
export function CopyEditorHost({ theme }: { theme: Theme }) {
  const hydrated = useSyncExternalStore(subscribeNever, isClient, isServer);
  const enabled = isCopyEditorEnabled();

  if (!enabled || !hydrated) return null;

  return (
    <Suspense fallback={null}>
      <LazyCopyEditorOverlay theme={theme} />
    </Suspense>
  );
}
