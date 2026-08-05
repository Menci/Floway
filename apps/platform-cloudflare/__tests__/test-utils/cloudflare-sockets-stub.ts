type CloudflareConnect = typeof import('cloudflare:sockets')['connect'];

let implementation: CloudflareConnect = () => {
  throw new Error('cloudflare:sockets test implementation is not installed');
};

export const installCloudflareConnect = (next: CloudflareConnect): void => {
  implementation = next;
};

export const resetCloudflareConnect = (): void => {
  implementation = () => {
    throw new Error('cloudflare:sockets test implementation is not installed');
  };
};

export const connect: CloudflareConnect = (address, options) => implementation(address, options);
