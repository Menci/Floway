import { createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

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
