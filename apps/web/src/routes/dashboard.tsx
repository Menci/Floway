import { NavigationRegular } from '@fluentui/react-icons';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Navigate,
  redirect,
  useMatches,
  useOutlet,
  useOutletContext,
} from 'react-router';

import type { Route } from './+types/dashboard';
import { requireDashboardSession } from './route-guards';
import type { AuthUser } from '../api/auth';
import { FlowayLogo } from '../components/logo';
import { usePageFrames } from '../components/page-frames';
import { Sidebar } from '../components/sidebar/sidebar';
import { OutcomeToastProvider } from '../components/ui/outcome-toast';
import { ScrollArea } from '../components/ui/scroll-area';
import { fluentComponents } from '../fluent';
import { isDashboardWorkspaceHandle } from '../lib/dashboard-route-handle';
import { prefersReducedMotion } from '../lib/reduced-motion';
import { useAuthStore } from '../stores/auth-store';
import { PAGE_ENTER_EASING, PAGE_ENTER_MS, PAGE_ENTER_OFFSET_PX, PAGE_LEAVE_MS } from '../winui/motion';

const { Button, DrawerBody, OverlayDrawer } = fluentComponents;

export interface DashboardOutletContext {
  user: AuthUser;
}

export async function clientLoader() {
  requireDashboardSession();
  const user = await useAuthStore.getState().initialize();
  if (user) return null;
  const error = useAuthStore.getState().error;
  if (error) throw new Error(error);
  throw redirect('/');
}

// The signed-in check is its own component so everything below it takes a user
// rather than a user-or-null: a hook cannot run behind a condition, so one
// component would put the guard under every hook.
export default function Dashboard({}: Route.ComponentProps) {
  const user = useAuthStore(state => state.user);
  if (!user) return <Navigate replace to="/" />;
  return <DashboardShell user={user} />;
}

function DashboardShell({ user }: { user: AuthUser }) {
  const { t } = useTranslation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  // The entrance is started on the element rather than declared in the sheet;
  // ../winui/page-transition.css.ts says why it cannot be declared. An animation
  // created in a layout effect stays pending until the frame that paints, so its
  // first painted pixel is its own first key frame however late that frame is.
  // React state and a deliberate one-turn wait were both tried, and both put
  // frames between the page appearing and the page moving.
  const firstFrameRef = useRef<HTMLDivElement>(null);
  const entranceStarted = useRef(false);
  useLayoutEffect(() => {
    // StrictMode runs a layout effect twice in development, and this one has
    // nothing to clean up: a second animation starts from an offset the first
    // has already left, so the page rises, drops back and rises again. A ref
    // survives the double invocation where the effect body does not.
    if (entranceStarted.current) return;
    if (prefersReducedMotion()) return;
    const frame = firstFrameRef.current;
    if (!frame) return;
    entranceStarted.current = true;
    // A pending animation applies no fill, so the class has to hold the frame at
    // its first key frame until the animation starts -- and both halves happen in
    // this one synchronous block so nothing paints between them. Declared in the
    // markup instead, the class would park the page below where it belongs for
    // anyone whose browser never ran this effect or who asked for less motion.
    frame.classList.add('floway-page-entrance');
    frame.animate(
      [{ translate: `0 ${PAGE_ENTER_OFFSET_PX}px` }, { translate: 'none' }],
      { duration: PAGE_ENTER_MS, easing: PAGE_ENTER_EASING, fill: 'forwards' },
    );
  }, []);
  const workspace = useMatches().some(match => isDashboardWorkspaceHandle(match.handle));
  // `useOutlet` keys its element on the context object, and the held page is one
  // of those elements: a new context every render remounts it.
  const outletContext = useMemo(() => ({ user } satisfies DashboardOutletContext), [user]);
  const outlet = useOutlet(outletContext);
  // The scroller belongs to the page rather than to the shell, so a held page
  // keeps its own scroll position and height rule while it leaves. Only a
  // workspace page is confined to the scroller's height; the scroller's content
  // box is the one box in this chain whose parent has a height for a percentage
  // to resolve against.
  const page = <ScrollArea
    axes="vertical"
    className="h-full min-h-0"
    contentClassName={workspace ? 'h-full' : 'min-h-full'}
    noTabIndex
  >
    <div className={workspace
      ? 'h-full min-h-0 p-[22px_var(--floway-page-inset)_var(--floway-page-inset)] max-[680px]:p-4'
      : 'p-[22px_var(--floway-page-inset)_var(--floway-page-inset)] max-[680px]:p-4'}>{outlet}</div>
  </ScrollArea>;
  const frames = usePageFrames(page, PAGE_LEAVE_MS);

  return (
    <OutcomeToastProvider>
      <a
        className="fixed left-3 top-3 z-[100000] -translate-y-20 rounded-md bg-fui-bg1 px-3 py-2 text-fui-fg1 shadow-lg focus:translate-y-0"
        href="#dashboard-main"
      >
        {t('dashboard.nav.skip')}
      </a>
      <div className="grid grid-cols-[clamp(240px,18vw,290px)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] h-[100dvh] min-h-0 max-[900px]:grid-cols-1 max-[900px]:grid-rows-[58px_minmax(0,1fr)]">
        <div className="min-h-0 max-[900px]:hidden">
          <Sidebar user={user} />
        </div>
        <header className="hidden max-[900px]:flex items-center gap-3 border-b border-b-solid border-fui-stroke1 px-4">
          <Button
            appearance="subtle"
            aria-label={t('dashboard.nav.open')}
            icon={<NavigationRegular />}
            onClick={() => setNavigationOpen(true)}
          />
          <FlowayLogo />
        </header>
        {/* Two pages can be on screen at once, stacked in one grid cell: the
            leaving page under the arriving one. ../components/page-frames.tsx
            keeps the leaving one rendering after the router has moved past
            it. */}
        <div className="grid grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] min-h-0">
          {frames.map(frame => <div
            aria-hidden={frame.leaving || undefined}
            className={`col-start-1 row-start-1 min-h-0 ${frame.leaving ? 'floway-page-leaving' : frame.id > 0 ? 'floway-page-entering' : ''}`}
            id={frame.leaving ? undefined : 'dashboard-main'}
            role={frame.leaving ? undefined : 'main'}
            inert={frame.leaving}
            key={frame.id}
            ref={frame.id === 0 && !frame.leaving ? firstFrameRef : undefined}
            tabIndex={frame.leaving ? undefined : -1}
          >{frame.node}</div>)}
        </div>
      </div>
      <OverlayDrawer
        aria-label={t('dashboard.nav.label')}
        backdropMotion={null}
        onOpenChange={(_, data) => setNavigationOpen(data.open)}
        open={navigationOpen}
        position="start"
        surfaceMotion={null}
      >
        <DrawerBody className="!p-0">
          <Sidebar onNavigate={() => setNavigationOpen(false)} user={user} />
        </DrawerBody>
      </OverlayDrawer>
    </OutcomeToastProvider>
  );
}

export const useDashboardOutletContext = (): DashboardOutletContext => useOutletContext<DashboardOutletContext>();
