import { createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

// Nothing from `src/` is on the stack here on purpose: what this pins is the
// React Router invariant the dashboard is built on top of, not our use of it.
// Every route puts its authentication and initial resources in a
// `clientLoader` and none of them renders a pending state, because the router
// keeps the current URL and the current component tree mounted until the next
// loader resolves. `page-frames.tsx` reads the committed entry's state to
// decide whether to play the page transition, which is only meaningful because
// the entry commits after the barrier rather than before it.
//
// A React Router upgrade that moved the commit ahead of the loader would show
// every route as an empty frame with no failure anywhere in our own tests, so
// this is the one place the assumption is written down as an assertion.
describe('route resource barriers', () => {
  it('keeps the committed URL and route until the next loader resolves', async () => {
    let release: (value: null) => void = () => {};
    const resource = new Promise<null>(resolve => {
      release = resolve;
    });
    const router = createMemoryRouter([
      { path: '/current', element: null },
      { path: '/next', loader: () => resource, element: null },
    ], { initialEntries: ['/current'] });

    router.initialize();
    const navigation = router.navigate('/next');
    await Promise.resolve();

    expect(router.state.location.pathname).toBe('/current');
    expect(router.state.navigation.location?.pathname).toBe('/next');
    expect(router.state.navigation.state).toBe('loading');

    release(null);
    await navigation;

    expect(router.state.location.pathname).toBe('/next');
    expect(router.state.navigation.state).toBe('idle');
    router.dispose();
  });
});
