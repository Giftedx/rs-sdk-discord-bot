import type { ServerWebSocket } from 'bun';

export interface FakeGateway {
  url: string;
  received: any[];                       // every parsed message from the proxy, in order
  connectCount: number;                  // count of sdk_connect messages
  send(msg: object): void;               // to the proxy
  dropConnection(): void;
  stop(): Promise<void>;
}

export function startFakeGateway(opts: { rejectPassword?: boolean } = {}): Promise<FakeGateway> {
  const sockets = new Set<ServerWebSocket<unknown>>();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      open(ws) { sockets.add(ws); },
      close(ws) { sockets.delete(ws); },
      message(ws, data) {
        const msg = JSON.parse(String(data));
        gw.received.push(msg);
        if (msg.type !== 'sdk_connect') return;
        gw.connectCount++;
        if (opts.rejectPassword) {
          ws.send(JSON.stringify({ type: 'sdk_error', error: 'Invalid credentials' }));
          return;
        }
        ws.send(JSON.stringify({ type: 'sdk_connected', success: true, mode: 'control', otherControllers: 0, maxMessageLength: 80 }));
      },
    },
  });

  const gw: FakeGateway = {
    url: `ws://127.0.0.1:${server.port}`,
    received: [],
    connectCount: 0,
    send(msg) { for (const ws of sockets) ws.send(JSON.stringify(msg)); },
    dropConnection() { for (const ws of sockets) ws.close(); },
    // Not awaited: see the note in proxy.ts stop(). The listener closes synchronously.
    async stop() { void server.stop(true); },
  };
  return Promise.resolve(gw);
}
