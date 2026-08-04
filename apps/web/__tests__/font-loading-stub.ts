import { afterEach, beforeEach } from 'vitest';

// happy-dom ships no `FontFaceSet`, and the app measures text only once the
// fonts a page asked for have arrived. A suite that renders a measuring
// component installs one whose `ready` is already settled, so the measurement
// that follows the load runs in the same act as the mount.
export const stubFontLoading = (): void => {
  const original = Object.getOwnPropertyDescriptor(document, 'fonts');

  beforeEach(() => {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
  });

  afterEach(() => {
    if (original) Object.defineProperty(document, 'fonts', original);
    else Reflect.deleteProperty(document, 'fonts');
  });
};
