import { NavigationRegular } from '@fluentui/react-icons';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Navigate,
  redirect,
  useMatches,
  useOutlet,
  useOutletContext,
} from 'react-router';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard';
import { requireDashboardSession } from './guards';
import type { AuthUser } from '../api/auth';
import { FlowayLogo } from '../components/logo';
import { usePageFrames } from '../components/page-frames';
import { Sidebar } from '../components/sidebar/nav';
import { SCROLLPORT_FILL_CLASS } from '../components/ui/layout';
import { OutcomeToastProvider } from '../components/ui/outcome-toast';
import { ScrollArea } from '../components/ui/scroll-area';
import { fluentComponents } from '../fluent';
import { isDashboardWorkspaceHandle } from '../lib/dashboard-route-handle';
import { prefersReducedMotion } from '../lib/reduced-motion';
import { useAuthStore } from '../stores/auth-store';
import { PAGE_ENTER_EASING, PAGE_ENTER_MS, PAGE_ENTER_OFFSET_PX } from '../winui/motion';

const { Button, DrawerBody, OverlayDrawer } = fluentComponents;

export interface DashboardOutletContext {
  user: AuthUser;
}

export async function clientLoader() {
  requireDashboardSession();
  const user = await useAuthStore.getState().initialize();
  if (user) return null;
  const error = useAuthStore.getState().error;
  if (error) throw new Error(error.message, { cause: error });
  throw redirect('/');
}

// The signed-in check is its own component so everything below takes a user
// rather than a user-or-null: a hook cannot run behind a condition.
export default function Dashboard({}: Route.ComponentProps) {
  const user = useAuthStore(state => state.session?.user ?? null);
  if (!user) return <Navigate replace to="/" />;
  return <DashboardShell user={user} />;
}

function DashboardShell({ user }: { user: AuthUser }) {
  const { t } = useTranslation();
  const [navigationOpen, setNavigationOpen] = useState(false);
  // The entrance is started on the element, not declared in the sheet;
  // ../winui/page-transition.css.ts says why. React state and a deliberate
  // one-turn wait both put frames between the page appearing and it moving.
  const firstFrameRef = useRef<HTMLDivElement>(null);
  const entranceStarted = useRef(false);
  useLayoutEffect(() => {
    // StrictMode double-invokes layout effects in development; a second
    // animation would start from an offset the first has already left.
    if (entranceStarted.current) return;
    if (prefersReducedMotion()) return;
    const frame = firstFrameRef.current;
    if (!frame) return;
    entranceStarted.current = true;
    // A pending animation applies no fill, so the class holds the frame at its
    // first key frame -- in this same synchronous block, so nothing paints
    // between. Declared in the markup it would park the page low for anyone
    // whose browser never ran this effect or who asked for less motion.
    frame.classList.add('floway-page-entrance');
    frame.animate(
      [{ translate: `0 ${PAGE_ENTER_OFFSET_PX}px` }, { translate: 'none' }],
      { duration: PAGE_ENTER_MS, easing: PAGE_ENTER_EASING, fill: 'forwards' },
    );
  }, []);
  const workspace = useMatches().some(match => isDashboardWorkspaceHandle(match.handle));
  // `useOutlet` keys its element on the context object, so a new context every
  // render remounts the held page.
  const outletContext = useMemo(() => ({ user } satisfies DashboardOutletContext), [user]);
  const outlet = useOutlet(outletContext);
  // The scroller belongs to the page, not the shell, so a held page keeps its
  // own scroll position while it leaves. Its content box is the one box in this
  // chain whose parent has a height for the workspace percentage to resolve.
  const page = <ScrollArea
    axes="vertical"
    className="h-full min-h-0"
    contentClassName={workspace ? 'h-full' : 'min-h-full'}
    noTabIndex
  >
    <div className={`${workspace ? SCROLLPORT_FILL_CLASS : ''} p-[22px_var(--floway-page-inset)_var(--floway-page-inset)] max-[680px]:p-4`}>{outlet}</div>
  </ScrollArea>;
  const frames = usePageFrames(page);

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
        <header className="hidden max-[900px]:flex items-center gap-3 border-b border-b-solid border-fui-divider px-4">
          <Button
            appearance="subtle"
            aria-label={t('dashboard.nav.open')}
            icon={<NavigationRegular />}
            onClick={() => setNavigationOpen(true)}
          />
          <FlowayLogo />
        </header>
        <div className="grid grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] min-h-0">
          {frames.map(frame => <div
            aria-hidden={frame.leaving || undefined}
            className={`col-start-1 row-start-1 min-h-0 ${frame.leaving ? 'floway-page-leaving' : frame.id > 0 ? 'floway-page-entering' : ''}`}
            id={frame.leaving ? undefined : 'dashboard-main'}
            role={frame.leaving ? undefined : 'main'}
            inert={frame.leaving}
            key={frame.id}
            onAnimationEnd={frame.onAnimationEnd}
            ref={frame.id === 0 && !frame.leaving ? firstFrameRef : undefined}
            tabIndex={frame.leaving ? undefined : -1}
          >{frame.node}</div>)}
        </div>
      </div>
      <OverlayDrawer
        aria-label={t('dashboard.nav.label')}
        backdrop={{ className: 'floway-drawer-light-dismiss' }}
        onOpenChange={(_, data) => setNavigationOpen(data.open)}
        open={navigationOpen}
        position="start"
      >
        <DrawerBody className="!p-0">
          <Sidebar onNavigate={() => setNavigationOpen(false)} user={user} />
        </DrawerBody>
      </OverlayDrawer>
    </OutcomeToastProvider>
  );
}

export const useDashboardOutletContext = (): DashboardOutletContext => useOutletContext<DashboardOutletContext>();
