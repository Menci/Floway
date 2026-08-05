import type { TimingSafeEqual } from '@floway-dev/platform';

export const timingSafeEqual: TimingSafeEqual = (a, b) => crypto.subtle.timingSafeEqual(a, b);
