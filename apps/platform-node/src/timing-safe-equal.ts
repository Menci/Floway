import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

import type { TimingSafeEqual } from '@floway-dev/platform';

export const timingSafeEqual: TimingSafeEqual = (a, b) => nodeTimingSafeEqual(a, b);
