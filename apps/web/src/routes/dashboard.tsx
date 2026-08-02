import { NavigationRegular } from '@fluentui/react-icons';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Navigate,
  Outlet,
  redirect,
  useMatches,
  useOutletContext,
} from 'react-router';

import type { Route } from './+types/dashboard';
import type { AuthUser } from '../api/auth';
import { getSessionToken } from '../auth/session';
import { FlowayLogo } from '../components/logo';
import { Sidebar } from '../components/sidebar/sidebar';
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
  const token = getSessionToken();
  if (!token) throw redirect('/');
  const user = await useAuthStore.getState().initialize();
  if (user) return null;
  const error = useAuthStore.getState().error;
  if (error) throw new Error(error);
  throw redirect('/');
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Dashboard | Floway' }];
}

export default function Dashboard({}: Route.ComponentProps) {
  const { t } = useTranslation();
  const user = useAuthStore(state => state.user);
  const [navigationOpen, setNavigationOpen] = useState(false);
  // The entrance, started on the element rather than declared in the sheet.
  // ../winui/page-transition.css.ts says why it cannot be declared; this is the
  // other half, and the whole of it is where the call sits.
  //
  // A layout effect runs after the frame is in the document and before anything
  // is painted, and an animation created there is pending until the next time
  // the browser updates animations -- which is the frame that paints the frame.
  // So its first painted pixel is its own first key frame, whether that frame
  // comes one tick later or seventy: the wait moves, the starting position does
  // not. Nothing here goes through React state and nothing waits a turn on
  // purpose. Both were tried and both put frames between the page appearing and
  // the page moving.
  const scrollerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (prefersReducedMotion()) return;
    // ScrollArea hands out its viewport; the frame is the host around it.
    const frame = scrollerRef.current?.parentElement;
    if (!frame) return;
    // The offset is put on the element here rather than in the sheet, and both
    // halves happen in this one synchronous block so no frame is painted
    // between them. A pending animation applies no fill, so something has to
    // hold the frame at its first key frame until the animation starts -- and
    // if that something were a class in the markup, a reader whose browser
    // never ran this effect, or who asked for less motion, would be left
    // looking at a page parked 140 below where it belongs. Nothing holds it
    // unless the thing that releases it has already been created.
    frame.classList.add('floway-page-entrance');
    frame.animate(
      [{ translate: `0 ${PAGE_ENTER_OFFSET_PX}px` }, { translate: 'none' }],
      { duration: PAGE_ENTER_MS, easing: PAGE_ENTER_EASING, fill: 'forwards' },
    );
  }, []);
  const workspace = useMatches().some(match => isDashboardWorkspaceHandle(match.handle));

  if (!user) return <Navigate replace to="/" />;

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
        {/* The scroller, not the `<main>` inside it, is what the page
            transition animates: it is the one box in this chain that is always
            exactly the viewport's height, so the snapshot the browser takes of
            it is bounded however long the page it holds turns out to be. See
            ../winui/page-transition.css.ts, which also says why the entrance
            waits for `entered` rather than being declared at mount. */}
        <ScrollArea
          axes="vertical"
          className="min-h-0 floway-page-transition"
          contentClassName={workspace ? 'h-full' : 'min-h-full'}
          noTabIndex
          ref={scrollerRef}
        >
          {/* Only a workspace page is confined to the scroller's height. Every
              other page is height-by-content and scrolls; the scroller's own
              content box already carries the minimum that fills the viewport,
              and it is the one box in this chain whose parent has a height for
              a percentage to resolve against. */}
          <main id="dashboard-main" tabIndex={-1} className={workspace
            ? 'h-full min-h-0 p-[22px_var(--floway-page-inset)_var(--floway-page-inset)] max-[680px]:p-4'
            : 'p-[22px_var(--floway-page-inset)_var(--floway-page-inset)] max-[680px]:p-4'}>
            <Outlet context={{ user } satisfies DashboardOutletContext} />
          </main>
        </ScrollArea>
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
