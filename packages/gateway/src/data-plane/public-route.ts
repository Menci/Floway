import type { PublicDataPlaneRoute } from '@floway-dev/protocols/common';

export const mountPublicRoute = (
  route: PublicDataPlaneRoute,
  register: (method: PublicDataPlaneRoute['method'], path: string) => void,
) => {
  for (const path of route.paths) register(route.method, path);
};
