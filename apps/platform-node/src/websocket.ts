import { upgradeWebSocket, type serve } from '@hono/node-server';
import type { Context } from 'hono';
import { WebSocketServer } from 'ws';

import {
  initResponsesWebSocketUpgradeResolver,
  type ResponsesWebSocketEvents,
} from '@floway-dev/gateway';

type NodeServeOptions = Parameters<typeof serve>[0];
type ResponsesWebSocketUpgradeResolver = (c: Context, events: ResponsesWebSocketEvents) => Response | Promise<Response>;
type ResponsesWebSocketUpgradeRegistrar = (resolver: ResponsesWebSocketUpgradeResolver) => void;

export const createNodeServeOptions = (fetch: NodeServeOptions['fetch'], port: number): NodeServeOptions => ({
  fetch,
  port,
  websocket: { server: new WebSocketServer({ noServer: true }) },
});

export const initNodeResponsesWebSocketUpgradeResolver = (
  register: ResponsesWebSocketUpgradeRegistrar = initResponsesWebSocketUpgradeResolver,
): void => {
  register((c, events) => upgradeWebSocket(c, events, { onError: err => console.error('[websocket]', err) }));
};
