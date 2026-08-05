// Minimal declaration for the cloudflare:sockets surface this composition root
// consumes. Keeping it local avoids importing the complete Workers ambient
// universe into the runtime-neutral workspace projects.
declare module 'cloudflare:sockets' {
  interface SocketInfo {
    remoteAddress?: string;
    localAddress?: string;
  }
  interface CloudflareSocket {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly closed: Promise<void>;
    /** Resolves when the underlying TCP / TLS handshake has finished;
     *  rejects with the connect / handshake error otherwise. */
    readonly opened: Promise<SocketInfo>;
    close(): Promise<void>;
  }
  interface SocketAddress {
    hostname: string;
    port: number;
  }
  interface SocketOptions {
    allowHalfOpen: boolean;
    secureTransport?: 'off' | 'on';
  }
  export const connect: (address: SocketAddress, options?: SocketOptions) => CloudflareSocket;
}
