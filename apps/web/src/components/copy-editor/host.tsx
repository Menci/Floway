import { lazy, Suspense, useEffect, useSyncExternalStore } from 'react';

import { activateCopyEditorTracking } from '../../i18n';
import { isCopyEditorEnabled } from '../../i18n/copy-editor/mirror';

const LazyCopyEditorOverlay = lazy(() => import('./overlay'));

const subscribeNever = () => () => {};
const isClient = () => true;
const isServer = () => false;

// Stays completely inert when copy editing is off: no overlay chunk is fetched
// and no markers are injected. When enabled, tracking starts only after client
// mount so prerendered hydration stays byte-identical.
export function CopyEditorHost() {
  const hydrated = useSyncExternalStore(subscribeNever, isClient, isServer);
  const enabled = isCopyEditorEnabled();

  useEffect(() => {
    if (!enabled || !hydrated) return;
    activateCopyEditorTracking();
  }, [enabled, hydrated]);

  if (!enabled || !hydrated) return null;

  return (
    <Suspense fallback={null}>
      <LazyCopyEditorOverlay />
    </Suspense>
  );
}
