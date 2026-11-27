import { afterEach, expect, test } from 'bun:test';
import { connect as netConnect } from 'node:net';
import { startFakeGateway, type FakeGateway } from '../testing/fake-gateway';
import { createActionPolicy } from './policy';
import { startProxy, type ProxyHandle } from './proxy';

const UPSTREAM_CONNECT = { type: 'sdk_connect', username: 'abc123', password: 'real-pw', mode: 'control', clientId: 'gamelink-proxy' };

let cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  cleanups = [];
});

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    await Bun.sleep(5);
  }
}

interface SetupOptions {
  onState?: (s: unknown, t: number) => void;
  reconnectDelayMs?: () => number;
  handshakeTimeoutMs?: number;
  rejectPassword?: boolean;
}

async function setup(o: SetupOptions = {}): Promise<{ gw: FakeGateway; proxy: ProxyHandle }> {
  const gw = await startFakeGateway({ rejectPassword: o.rejectPassword });
  cleanups.push(() => gw.stop());
  const proxy = await startProxy({
    upstreamUrl: gw.url, account: 'abc123', password: 'real-pw', bootToken: 'tok',
    listenPort: 0, policy: createActionPolicy(), onState: o.onState,
    reconnectDelayMs: o.reconnectDelayMs ?? (() => 20), handshakeTimeoutMs: o.handshakeTimeoutMs,
  });
  cleanups.push(() => proxy.stop());
  if (o.rejectPassword) await waitFor(() => gw.connectCount >= 1);
  else await waitFor(() => proxy.upstreamConnected());
  return { gw, proxy };
}

interface Box { ws: WebSocket; msgs: any[]; closed: Promise<void>; isClosed: () => boolean; }

function openBox(port: number): Box {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const msgs: any[] = [];
  let done = false;
  ws.onmessage = e => msgs.push(JSON.parse(String(e.data)));
  const closed = new Promise<void>(r => { ws.onclose = () => { done = true; r(); }; });
  cleanups.push(() => { if (!done) ws.close(); });
  return { ws, msgs, closed, isClosed: () => done };
}

async function connectBox(port: number, password = 'tok', username = 'abc123'): Promise<Box> {
  const box = openBox(port);
  await new Promise<void>((res, rej) => { box.ws.onopen = () => res(); box.ws.onerror = () => rej(new Error('box error')); });
  box.ws.send(JSON.stringify({ type: 'sdk_connect', username, password, clientId: 'box', mode: 'control' }));
  await waitFor(() => box.msgs.length > 0 || box.isClosed());
  return box;
}

const action = (type: string, actionId = 'a1') => ({ type: 'sdk_action', username: 'abc123', actionId, action: { type }, actionTimeoutMs: 1000 });

test('sends the real password upstream exactly once', async () => {
  const { gw } = await setup();
  expect(gw.received[0]).toEqual(UPSTREAM_CONNECT);
  expect(gw.connectCount).toBe(1);
});

test('answers the box locally and never forwards its sdk_connect', async () => {
  const { gw, proxy } = await setup();
  const box = await connectBox(proxy.port);
  expect(box.msgs[0]).toEqual({ type: 'sdk_connected', success: true, mode: 'control', otherControllers: 0, maxMessageLength: 80 });
  expect(gw.connectCount).toBe(1);
  expect(gw.received.length).toBe(1);
});

test('a box reconnect does not cause a second upstream connect', async () => {
  const { gw, proxy } = await setup();
  const first = await connectBox(proxy.port);
  first.ws.close();
  await first.closed;
  const second = await connectBox(proxy.port);
  expect(second.msgs[0].type).toBe('sdk_connected');
  expect(gw.connectCount).toBe(1);
});

test('a wrong token gets sdk_error and a closed socket', async () => {
  const { gw, proxy } = await setup();
  const box = await connectBox(proxy.port, 'wrong');
  await box.closed;
  expect(box.msgs).toEqual([{ type: 'sdk_error', error: 'unauthorized' }]);
  expect(gw.received.length).toBe(1);
});

test('a wrong account name gets sdk_error', async () => {
  const { proxy } = await setup();
  const box = await connectBox(proxy.port, 'tok', 'someone-else');
  await box.closed;
  expect(box.msgs).toEqual([{ type: 'sdk_error', error: 'unauthorized' }]);
});

test('an upgrade with an Origin header gets 403', async () => {
  const { proxy } = await setup();
  const response = await new Promise<string>((resolve, reject) => {
    const sock = netConnect(proxy.port, '127.0.0.1', () => {
      sock.write([
        'GET / HTTP/1.1', `Host: 127.0.0.1:${proxy.port}`, 'Upgrade: websocket', 'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13',
        'Origin: https://rs-sdk.maxbittker.com', '', '',
      ].join('\r\n'));
    });
    let buf = '';
    sock.on('data', d => { buf += d.toString(); if (buf.includes('\r\n')) { sock.destroy(); resolve(buf); } });
    sock.on('error', reject);
  });
  expect(response.startsWith('HTTP/1.1 403')).toBe(true);
});

test('relays state to the box and to the tap', async () => {
  const taps: unknown[] = [];
  const { gw, proxy } = await setup({ onState: s => taps.push(s) });
  const box = await connectBox(proxy.port);
  gw.send({ type: 'sdk_state', state: { tick: 1 } });
  await waitFor(() => box.msgs.length > 1);
  expect(box.msgs[1]).toEqual({ type: 'sdk_state', state: { tick: 1 } });
  expect(taps).toEqual([{ tick: 1 }]);
});

test('forwards an allowed action unchanged while a job runs', async () => {
  const { gw, proxy } = await setup();
  const box = await connectBox(proxy.port);
  proxy.setJobActive(true);
  const msg = { ...action('walkTo'), action: { type: 'walkTo', x: 3200, z: 3200 } };
  box.ws.send(JSON.stringify(msg));
  await waitFor(() => gw.received.length > 1);
  expect(gw.received[1]).toEqual(msg);
});

test('blocks interactPlayer and answers the box', async () => {
  const { gw, proxy } = await setup();
  const box = await connectBox(proxy.port);
  proxy.setJobActive(true);
  box.ws.send(JSON.stringify(action('interactPlayer', 'x9')));
  await waitFor(() => box.msgs.length > 1);
  expect(box.msgs[1]).toEqual({ type: 'sdk_action_result', actionId: 'x9', result: { success: false, message: 'blocked by policy: blocked_type' } });
  expect(gw.received.length).toBe(1);
});

test('blocks every action while no job runs', async () => {
  const { gw, proxy } = await setup();
  const box = await connectBox(proxy.port);
  box.ws.send(JSON.stringify(action('walkTo')));
  await waitFor(() => box.msgs.length > 1);
  expect(box.msgs[1].result.success).toBe(false);
  expect(box.msgs[1].result.message.endsWith('no_job')).toBe(true);
  expect(gw.received.length).toBe(1);
});

test('drops sdk_screenshot_request', async () => {
  const { gw, proxy } = await setup();
  const box = await connectBox(proxy.port);
  proxy.setJobActive(true);
  box.ws.send(JSON.stringify({ type: 'sdk_screenshot_request', username: 'abc123', screenshotId: 's1' }));
  // A later allowed action proves the proxy handled the screenshot request first and dropped it.
  box.ws.send(JSON.stringify(action('wait', 'a2')));
  await waitFor(() => gw.received.length > 1);
  expect(gw.received.slice(1).map(m => m.type)).toEqual(['sdk_action']);
  expect(box.msgs.length).toBe(1);
});

test('closes the box on invalid JSON and keeps upstream', async () => {
  const { proxy } = await setup();
  const box = await connectBox(proxy.port);
  box.ws.send('{not json');
  await box.closed;
  expect(proxy.upstreamConnected()).toBe(true);
});

test('closes the box on a message larger than 65536 bytes', async () => {
  const { gw, proxy } = await setup();
  const box = await connectBox(proxy.port);
  proxy.setJobActive(true);
  box.ws.send(JSON.stringify({ ...action('say'), action: { type: 'say', message: 'x'.repeat(65_536) } }));
  await box.closed;
  expect(gw.received.length).toBe(1);
  expect(proxy.upstreamConnected()).toBe(true);
});

test('a second box replaces the first', async () => {
  const { gw, proxy } = await setup();
  const first = await connectBox(proxy.port);
  const second = await connectBox(proxy.port);
  await first.closed;
  expect(second.msgs[0].type).toBe('sdk_connected');
  expect(second.isClosed()).toBe(false);
  expect(gw.connectCount).toBe(1);
});

test('reconnects upstream after a drop and keeps the box open', async () => {
  const { gw, proxy } = await setup();
  const box = await connectBox(proxy.port);
  gw.dropConnection();
  await Bun.sleep(100);
  expect(gw.connectCount).toBe(2);
  expect(gw.received[1]).toEqual(UPSTREAM_CONNECT);
  expect(box.ws.readyState).toBe(WebSocket.OPEN);
});

test('the real password never reaches the box', async () => {
  const { gw, proxy } = await setup();
  const box = await connectBox(proxy.port);
  proxy.setJobActive(true);
  gw.send({ type: 'sdk_info', message: 'hello', maxMessageLength: 80 });
  gw.send({ type: 'sdk_state', state: { tick: 2 } });
  box.ws.send(JSON.stringify(action('interactPlayer')));
  await waitFor(() => box.msgs.length >= 4);
  for (const m of box.msgs) expect(JSON.stringify(m)).not.toContain('real-pw');
});

test('relays a re-sent sdk_connected to the box and stores it', async () => {
  const { gw, proxy } = await setup();
  const box = await connectBox(proxy.port);
  const resent = { type: 'sdk_connected', success: true, maxMessageLength: 120 };
  gw.send(resent);
  await waitFor(() => box.msgs.length > 1);
  expect(box.msgs[1]).toEqual(resent);
  box.ws.close();
  await box.closed;
  const next = await connectBox(proxy.port);
  expect(next.msgs[0]).toEqual(resent);
});

test('relays an upstream sdk_error after the handshake', async () => {
  const { gw, proxy } = await setup();
  const box = await connectBox(proxy.port);
  const err = { type: 'sdk_error', actionId: 'a1', error: 'Bot not connected' };
  gw.send(err);
  await waitFor(() => box.msgs.length > 1);
  expect(box.msgs[1]).toEqual(err);
  expect(proxy.upstreamConnected()).toBe(true);
  expect(box.isClosed()).toBe(false);
});

test('answers an allowed action while upstream is down and does not queue it', async () => {
  const { gw, proxy } = await setup({ reconnectDelayMs: () => 150 });
  const box = await connectBox(proxy.port);
  proxy.setJobActive(true);
  gw.dropConnection();
  await waitFor(() => !proxy.upstreamConnected());
  box.ws.send(JSON.stringify(action('walkTo', 'd1')));
  await waitFor(() => box.msgs.length > 1);
  expect(box.msgs[1]).toEqual({ type: 'sdk_action_result', actionId: 'd1', result: { success: false, message: 'upstream not connected' } });
  await waitFor(() => proxy.upstreamConnected());
  await Bun.sleep(30);
  expect(gw.connectCount).toBe(2);
  expect(gw.received.filter(m => m.type === 'sdk_action')).toEqual([]);
});

test('closes a box socket that sends no sdk_connect within the handshake timeout', async () => {
  const { proxy } = await setup({ handshakeTimeoutMs: 30 });
  const box = openBox(proxy.port);
  await box.closed;
  expect(box.msgs).toEqual([]);
});

test('an authenticated box stays open past the handshake timeout', async () => {
  const { proxy } = await setup({ handshakeTimeoutMs: 30 });
  const box = await connectBox(proxy.port);
  await Bun.sleep(100);
  expect(box.ws.readyState).toBe(WebSocket.OPEN);
});

test('an upstream sdk_error on the handshake backs off and never reaches the box', async () => {
  const { gw, proxy } = await setup({ rejectPassword: true, reconnectDelayMs: () => 50 });
  expect(proxy.upstreamConnected()).toBe(false);
  await Bun.sleep(20);
  expect(gw.connectCount).toBe(1);
  const box = await connectBox(proxy.port);
  await box.closed;
  expect(box.msgs).toEqual([{ type: 'sdk_error', error: 'upstream not ready' }]);
  for (const m of box.msgs) expect(JSON.stringify(m)).not.toContain('real-pw');
  await Bun.sleep(250);
  // One attempt per 50 ms delay: about 6 after ~300 ms. A tight loop would make hundreds.
  expect(gw.connectCount).toBeGreaterThanOrEqual(3);
  expect(gw.connectCount).toBeLessThanOrEqual(8);
  expect(proxy.upstreamConnected()).toBe(false);
});
