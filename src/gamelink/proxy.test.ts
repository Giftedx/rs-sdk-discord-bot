import { afterEach, expect, test } from 'bun:test';
import { connect as netConnect } from 'node:net';
import { startFakeGateway, type FakeGateway } from '../testing/fake-gateway';
import { createActionPolicy } from './policy';
import { BOX_BUFFER_LIMIT_BYTES, sendLimited, startProxy, type ProxyHandle, type ProxyTimers } from './proxy';

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
  rejectError?: string;
  silent?: boolean;
  upstreamHandshakeTimeoutMs?: number;
  staleMs?: number;
  maxReconnectDelayMs?: number;
  log?: (line: string) => void;
  timers?: ProxyTimers;
}

async function setup(o: SetupOptions = {}): Promise<{ gw: FakeGateway; proxy: ProxyHandle }> {
  const gw = await startFakeGateway({ rejectPassword: o.rejectPassword, rejectError: o.rejectError, silent: o.silent });
  cleanups.push(() => gw.stop());
  const proxy = await startProxy({
    upstreamUrl: gw.url, account: 'abc123', password: 'real-pw', bootToken: 'tok',
    listenPort: 0, policy: createActionPolicy(), onState: o.onState,
    reconnectDelayMs: o.reconnectDelayMs ?? (() => 20), handshakeTimeoutMs: o.handshakeTimeoutMs,
    upstreamHandshakeTimeoutMs: o.upstreamHandshakeTimeoutMs, staleMs: o.staleMs,
    maxReconnectDelayMs: o.maxReconnectDelayMs, log: o.log, timers: o.timers,
  });
  cleanups.push(() => proxy.stop());
  if (o.rejectPassword || o.silent) await waitFor(() => gw.connectCount >= 1);
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
  // Delays 50, 100, 200 ms: 3 or 4 attempts after ~300 ms. A tight loop would make hundreds.
  expect(gw.connectCount).toBeGreaterThanOrEqual(2);
  expect(gw.connectCount).toBeLessThanOrEqual(5);
  expect(proxy.upstreamConnected()).toBe(false);
});

const delaysIn = (lines: string[]) =>
  lines.map(l => /reconnect to the gateway in (\d+) ms/.exec(l)?.[1]).filter((d): d is string => d !== undefined).map(Number);

test('a refused login doubles the delay up to the cap, logs the error text, and a connect resets it', async () => {
  const lines: string[] = [];
  const { gw, proxy } = await setup({ rejectPassword: true, reconnectDelayMs: () => 10, maxReconnectDelayMs: 40, log: l => lines.push(l) });
  await waitFor(() => gw.connectCount >= 5);
  expect(delaysIn(lines).slice(0, 4)).toEqual([10, 20, 40, 40]);
  expect(lines).toContain('gamelink proxy: the gateway refused the login: Invalid credentials');
  expect(proxy.status()).toMatchObject({ connected: false, lastError: 'the gateway refused the login: Invalid credentials' });
  expect(proxy.status().reconnects).toBeGreaterThanOrEqual(4);

  gw.rejectPassword = false;
  await waitFor(() => proxy.upstreamConnected());
  expect(proxy.status().lastError).toBeNull();
  lines.length = 0;
  gw.dropConnection();
  await waitFor(() => delaysIn(lines).length > 0);
  expect(delaysIn(lines)[0]).toBe(10);
  for (const l of lines) expect(l).not.toContain('real-pw');
});

test('the log redacts the password in a gateway error text', async () => {
  const lines: string[] = [];
  const { proxy } = await setup({ rejectPassword: true, rejectError: 'bad password real-pw\nline2', log: l => lines.push(l) });
  await waitFor(() => proxy.status().lastError !== null);
  expect(proxy.status().lastError).toBe('the gateway refused the login: bad password [redacted] line2');
  for (const l of lines) expect(l).not.toContain('real-pw');
});

test('closes a gateway socket that gives no sdk_connected within the handshake timeout and reconnects', async () => {
  const { gw, proxy } = await setup({ silent: true, upstreamHandshakeTimeoutMs: 30, reconnectDelayMs: () => 20 });
  await waitFor(() => gw.connectCount >= 2);
  expect(proxy.status()).toMatchObject({ connected: false, lastError: 'no sdk_connected from the gateway within 30 ms' });
  expect(proxy.status().reconnects).toBeGreaterThanOrEqual(1);
  gw.silent = false;
  await waitFor(() => proxy.upstreamConnected());
  expect(proxy.status()).toMatchObject({ connected: true, lastError: null });
});

function fakeTimers() {
  let next = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  const armed: number[] = [];
  const timers: ProxyTimers = {
    setTimeout(fn, ms) { const id = next++; pending.set(id, { fn, ms }); armed.push(ms); return id; },
    clearTimeout(id) { pending.delete(id as number); },
  };
  const fire = (ms: number) => {
    for (const [id, t] of [...pending]) if (t.ms === ms) { pending.delete(id); t.fn(); }
  };
  return { timers, armed, fire, has: (ms: number) => [...pending.values()].some(t => t.ms === ms) };
}

test('a ready gateway socket with no message for staleMs is closed and reconnected', async () => {
  const ft = fakeTimers();
  const { gw, proxy } = await setup({ timers: ft.timers, reconnectDelayMs: () => 20 });
  expect(ft.has(60_000)).toBe(true);           // the default staleMs
  const before = ft.armed.filter(ms => ms === 60_000).length;
  gw.send({ type: 'sdk_state', state: { tick: 1 } });
  await waitFor(() => ft.armed.filter(ms => ms === 60_000).length > before);   // each message restarts the timer
  ft.fire(60_000);
  expect(proxy.status()).toMatchObject({ connected: false, lastError: 'no message from the gateway for 60000 ms' });
  expect(ft.has(20)).toBe(true);
  ft.fire(20);
  await waitFor(() => proxy.upstreamConnected());
  expect(gw.connectCount).toBe(2);
  expect(proxy.status().reconnects).toBe(1);
});

function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length > 125) throw new Error('short frames only');
  const mask = Buffer.from([1, 2, 3, 4]);
  const body = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, body]);
}

test('a box that stops reading gets no more state, and the proxy does not buffer it', async () => {
  const lines: string[] = [];
  const { gw, proxy } = await setup({ log: l => lines.push(l) });
  const sock = netConnect(proxy.port, '127.0.0.1');
  cleanups.push(() => { sock.destroy(); });
  await new Promise<void>(r => sock.once('connect', () => r()));
  sock.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  await new Promise<void>(r => sock.once('data', () => r()));
  sock.write(maskedTextFrame(JSON.stringify({ type: 'sdk_connect', username: 'abc123', password: 'tok' })));
  await Bun.sleep(50);
  sock.pause();
  const big = 'x'.repeat(60_000);
  for (let i = 0; i < 400 && !lines.some(l => l.includes('dropping state')); i++) {
    gw.send({ type: 'sdk_state', state: { pad: big, i } });
    if (i % 20 === 0) await Bun.sleep(5);
  }
  await waitFor(() => lines.some(l => l.includes('dropping state')), 5000);
  expect(proxy.upstreamConnected()).toBe(true);
}, 15_000);

test('sendLimited drops state above the box buffer limit and still sends other messages', () => {
  let buffered = BOX_BUFFER_LIMIT_BYTES + 1;
  const sent: string[] = [];
  const ws = { send: (t: string) => { sent.push(t); return -1; }, getBufferedAmount: () => buffered };
  expect(sendLimited(ws, 'state', true)).toBe(false);
  expect(sendLimited(ws, 'result', false)).toBe(true);
  expect(sent).toEqual(['result']);
  buffered = 0;
  expect(sendLimited(ws, 'state2', true)).toBe(true);
  expect(sent).toEqual(['result', 'state2']);
  const full = { send: () => 0, getBufferedAmount: () => 0 };
  expect(sendLimited(full, 'x', false)).toBe(false);
});

test('counts actions in flight until their result; waitIdle resolves when the last result comes', async () => {
  const { gw, proxy } = await setup();
  const box = await connectBox(proxy.port);
  proxy.setJobActive(true);
  expect(proxy.actionsInFlight()).toBe(0);
  expect(await proxy.waitIdle(1_000)).toBe(true);
  box.ws.send(JSON.stringify(action('walkTo', 'a1')));
  box.ws.send(JSON.stringify(action('walkTo', 'a2')));
  box.ws.send(JSON.stringify(action('interactPlayer', 'a3')));   // blocked: never in flight
  await waitFor(() => gw.received.length >= 3);
  await Bun.sleep(20);
  expect(proxy.actionsInFlight()).toBe(2);
  const idle = proxy.waitIdle(5_000);
  gw.send({ type: 'sdk_action_result', actionId: 'a1', result: { success: true, message: 'ok' } });
  await waitFor(() => proxy.actionsInFlight() === 1);
  gw.send({ type: 'sdk_action_result', actionId: 'a2', result: { success: true, message: 'ok' } });
  expect(await idle).toBe(true);
  expect(proxy.actionsInFlight()).toBe(0);
});

test('an sdk_error with the actionId ends that action in flight', async () => {
  const { gw, proxy } = await setup();
  const box = await connectBox(proxy.port);
  proxy.setJobActive(true);
  box.ws.send(JSON.stringify(action('walkTo', 'e1')));
  await waitFor(() => gw.received.length >= 2);
  await Bun.sleep(20);
  expect(proxy.actionsInFlight()).toBe(1);
  gw.send({ type: 'sdk_error', actionId: 'e1', error: 'Bot not connected' });
  await waitFor(() => proxy.actionsInFlight() === 0);
  gw.send({ type: 'sdk_error', error: 'no id' });   // no actionId: changes nothing, does not throw
  await Bun.sleep(20);
  expect(proxy.actionsInFlight()).toBe(0);
});

test('waitIdle gives false after its timeout, caps it at 30 s, and an upstream drop clears the count', async () => {
  const delays: number[] = [];
  const pending: (() => void)[] = [];
  const timers: ProxyTimers = {
    setTimeout: (fn, ms) => { delays.push(ms); pending.push(fn); return pending.length; },
    clearTimeout: () => {},
  };
  const gw = await startFakeGateway();
  cleanups.push(() => gw.stop());
  const proxy = await startProxy({ upstreamUrl: gw.url, account: 'abc123', password: 'real-pw', bootToken: 'tok', listenPort: 0, policy: createActionPolicy(), timers, reconnectDelayMs: () => 20 });
  cleanups.push(() => proxy.stop());
  await waitFor(() => proxy.upstreamConnected());
  const box = await connectBox(proxy.port);
  proxy.setJobActive(true);
  box.ws.send(JSON.stringify(action('walkTo', 'b1')));
  await waitFor(() => proxy.actionsInFlight() === 1);
  const n = delays.length;
  const idle = proxy.waitIdle(120_000);
  expect(delays[n]).toBe(30_000);
  pending[n]!();
  expect(await idle).toBe(false);
  const idle2 = proxy.waitIdle(10_000);
  gw.dropConnection();
  expect(await idle2).toBe(true);
  expect(proxy.actionsInFlight()).toBe(0);
});

test('an action with no result stops counting after inFlightMaxAgeMs', async () => {
  let t = 0;
  const gw = await startFakeGateway();
  cleanups.push(() => gw.stop());
  const proxy = await startProxy({ upstreamUrl: gw.url, account: 'abc123', password: 'real-pw', bootToken: 'tok', listenPort: 0, policy: createActionPolicy(), now: () => t, inFlightMaxAgeMs: 1_000 });
  cleanups.push(() => proxy.stop());
  await waitFor(() => proxy.upstreamConnected());
  const box = await connectBox(proxy.port);
  proxy.setJobActive(true);
  box.ws.send(JSON.stringify(action('walkTo', 'c1')));
  await waitFor(() => proxy.actionsInFlight() === 1);
  t = 1_001;
  expect(proxy.actionsInFlight()).toBe(0);
});
