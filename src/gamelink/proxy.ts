import type { ServerWebSocket } from 'bun';
import { timingSafeEqual } from 'node:crypto';
import type { ActionPolicy } from './policy';

export interface ProxyOptions {
  upstreamUrl: string;              // gateway WebSocket URL (the relay URL of deriveGatewayUrl)
  // The direct gateway URL to try first. Default: directGatewayUrl(upstreamUrl). null: relay only.
  directUpstreamUrl?: string | null;
  account: string;
  password: string;                 // real game password, used only upstream
  bootToken: string;                // the box sends this in the `password` field of sdk_connect
  listenPort: number;               // 0 picks a free port
  policy: ActionPolicy;
  onState?: (state: unknown, receivedAtMs: number) => void;   // the state tap
  reconnectDelayMs?: () => number;  // default: 11_000 + random 0..5_000
  now?: () => number;
  handshakeTimeoutMs?: number;      // default 5000: a box socket without a valid sdk_connect by then is closed
  upstreamHandshakeTimeoutMs?: number; // default 10_000: a gateway socket without sdk_connected by then is closed
  staleMs?: number;                 // default 60_000: a ready gateway socket with no message for this long is closed
  maxReconnectDelayMs?: number;     // default 300_000: the cap of the backoff after a refused login
  log?: (line: string) => void;     // one line per event; never holds the password or a raw gateway message
  timers?: ProxyTimers;             // default: the global setTimeout and clearTimeout
  inFlightMaxAgeMs?: number;        // default 120_000: an action with no result after this long no longer counts
}

export interface ProxyTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

export interface ProxyStatus {
  connected: boolean;
  lastError: string | null;         // the last gateway problem; null after a successful connect
  reconnects: number;               // count of gateway connect attempts after the first
  gateway: GatewayRoute;            // the route of the current or the next connect
}

export type GatewayRoute = 'direct' | 'relay';

export interface ProxyHandle {
  port: number;
  setJobActive(active: boolean): void;
  upstreamConnected(): boolean;
  status(): ProxyStatus;
  // Drops the gateway socket and connects again at once, the direct route first. For SIGUSR1.
  reconnect(): void;
  // Actions sent to the gateway whose sdk_action_result has not come yet.
  actionsInFlight(): number;
  // True when no action is in flight, at once or within timeoutMs (capped at WAIT_IDLE_CAP_MS).
  waitIdle(timeoutMs: number): Promise<boolean>;
  stop(): Promise<void>;
}

export const WAIT_IDLE_CAP_MS = 30_000;
const MAX_BOX_MESSAGE_BYTES = 65_536;
export const BOX_BUFFER_LIMIT_BYTES = 4 * 1024 * 1024;
const RELAYED_TYPES: ReadonlySet<string> = new Set(['sdk_state', 'sdk_action_result', 'sdk_info']);

interface BoxData { authed: boolean; handshakeTimer: ReturnType<typeof setTimeout> | null; }

// The direct gateway ports of the public servers: vendor/rs-sdk/sdk/index.ts DIRECT_GATEWAYS
// (preferDirectGateway). The direct port negotiates permessage-deflate and skips the relay on the
// tick thread of the game server, so state frames arrive about 6x smaller.
const DIRECT_GATEWAYS: Readonly<Record<string, string>> = {
  'wss://rs-sdk.maxbittker.com/gateway': 'wss://rs-sdk.maxbittker.com:7443',
};

/** The direct gateway URL for a relay URL, or null when the server has none. */
export function directGatewayUrl(relayUrl: string): string | null {
  return DIRECT_GATEWAYS[relayUrl] ?? null;
}

// The gateway tells a replaced controller this text (gateway.ts). The SDK stops its reconnects
// when it reads it, so the box would stay off after the proxy itself was replaced.
const PREEMPT_TEXT = 'another controller connected';
export const PREEMPT_RELAY_TEXT = 'Disconnected: the gateway connection of gamelink was replaced; it reconnects';

// The fields of sdk_action that the gateway reads (gateway.ts, handler of sdk_action).
export function rebuildAction(msg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { type: 'sdk_action', action: msg.action };
  if (msg.actionId !== undefined) out.actionId = msg.actionId;
  if (msg.actionTimeoutMs !== undefined) out.actionTimeoutMs = msg.actionTimeoutMs;
  return out;
}

export const defaultReconnectDelayMs = (random: () => number = Math.random) => 11_000 + Math.floor(random() * 5_001);

function tokenEquals(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual needs equal lengths; compare b with itself so the work does not depend on `given`.
  if (a.length !== b.length) return timingSafeEqual(b, b) && false;
  return timingSafeEqual(a, b);
}

/** Sends to the box. A droppable message (state) is dropped while the box has more than
 *  BOX_BUFFER_LIMIT_BYTES unsent. Returns false when the message was not queued. */
export function sendLimited(ws: { send(text: string): number; getBufferedAmount(): number }, text: string, droppable: boolean): boolean {
  if (droppable && ws.getBufferedAmount() > BOX_BUFFER_LIMIT_BYTES) return false;
  return ws.send(text) !== 0;
}

function errorText(v: unknown, password: string): string {
  let t = typeof v === 'string' ? v : 'unknown error';
  if (password && t.includes(password)) t = t.split(password).join('[redacted]');
  return t.replace(/[\r\n]+/g, ' ').slice(0, 200);
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function startProxy(opts: ProxyOptions): Promise<ProxyHandle> {
  const now = opts.now ?? Date.now;
  const reconnectDelayMs = opts.reconnectDelayMs ?? (() => defaultReconnectDelayMs());
  const directUrl = opts.directUpstreamUrl === undefined ? directGatewayUrl(opts.upstreamUrl) : opts.directUpstreamUrl;
  let useDirect = directUrl !== null;
  const route = (): GatewayRoute => (useDirect ? 'direct' : 'relay');
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 5_000;
  const upstreamHandshakeTimeoutMs = opts.upstreamHandshakeTimeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 60_000;
  const maxReconnectDelayMs = opts.maxReconnectDelayMs ?? 300_000;
  const log = (line: string) => { try { opts.log?.(`gamelink proxy: ${line}`); } catch { /* a failing log must not stop the proxy */ } };
  const timers: ProxyTimers = opts.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) };

  let stopped = false;
  let jobActive = false;
  let upstream: WebSocket | null = null;
  let upstreamReady = false;
  let reconnectTimer: unknown = null;
  let upstreamTimer: unknown = null;         // the handshake timeout, then the stale timer
  let refusals = 0;                          // consecutive refused logins
  let lastError: string | null = null;
  let attempts = 0;
  let lastConnected: string | null = null;   // last upstream sdk_connected, as received
  let box: ServerWebSocket<BoxData> | null = null;
  const inFlightMaxAgeMs = opts.inFlightMaxAgeMs ?? 120_000;
  const inFlight = new Map<string, number>();   // action key -> time sent
  const idleWaiters = new Set<() => void>();
  let anonActions = 0;
  const countInFlight = () => {
    const oldest = now() - inFlightMaxAgeMs;
    for (const [k, at] of inFlight) if (at < oldest) inFlight.delete(k);
    return inFlight.size;
  };
  const notifyIdle = () => {
    if (countInFlight() > 0) return;
    for (const w of [...idleWaiters]) w();
  };
  const actionKey = (id: unknown) => (typeof id === 'string' || typeof id === 'number' ? `id:${id}` : `anon:${anonActions++}`);

  let droppingState = false;
  const sendToBox = (text: string, droppable = false) => {
    if (!box || !box.data.authed) return;
    const sent = sendLimited(box, text, droppable);
    if (droppable && sent === droppingState) {
      droppingState = !sent;
      log(sent ? 'box buffer drained, state relay resumed' : `box has more than ${BOX_BUFFER_LIMIT_BYTES} bytes unsent, dropping state`);
    }
  };

  const clearUpstreamTimer = () => { if (upstreamTimer !== null) { timers.clearTimeout(upstreamTimer); upstreamTimer = null; } };
  const armUpstreamTimer = (ws: WebSocket, ms: number, reason: string) => {
    clearUpstreamTimer();
    upstreamTimer = timers.setTimeout(() => { upstreamTimer = null; dropUpstream(ws, reason, false); }, ms);
  };

  const scheduleReconnect = (refused: boolean) => {
    if (stopped || reconnectTimer !== null) return;
    refusals = refused ? refusals + 1 : 0;
    const base = reconnectDelayMs();
    const delay = refused ? Math.min(base * 2 ** (refusals - 1), maxReconnectDelayMs) : base;
    log(`reconnect to the gateway in ${delay} ms`);
    reconnectTimer = timers.setTimeout(() => { reconnectTimer = null; connectUpstream(); }, delay);
  };

  // Forgets the socket at once, so a half-open socket whose close never completes cannot block the reconnect.
  function dropUpstream(ws: WebSocket, reason: string, refused: boolean) {
    if (upstream !== ws) return;
    const wasReady = upstreamReady;
    upstream = null;
    upstreamReady = false;
    clearUpstreamTimer();
    lastError = reason;
    // No result comes for an action that was sent on this socket.
    inFlight.clear();
    notifyIdle();
    log(reason);
    try { ws.close(); } catch { /* already closed */ }
    if (useDirect && !wasReady && !refused && !stopped) {
      // The direct port did not answer: fall back to the relay at once.
      useDirect = false;
      log('the direct gateway did not connect; using the relay gateway');
      connectUpstream();
      return;
    }
    scheduleReconnect(refused);
  }

  function connectUpstream() {
    if (stopped || upstream) return;
    if (attempts++ > 0) log('connecting to the gateway again');
    const ws = new WebSocket(useDirect && directUrl !== null ? directUrl : opts.upstreamUrl);
    upstream = ws;
    upstreamReady = false;
    armUpstreamTimer(ws, upstreamHandshakeTimeoutMs, `no sdk_connected from the gateway within ${upstreamHandshakeTimeoutMs} ms`);

    ws.onopen = () => {
      if (upstream !== ws) return;
      ws.send(JSON.stringify({ type: 'sdk_connect', username: opts.account, password: opts.password, mode: 'control', clientId: 'gamelink-proxy' }));
    };
    ws.onmessage = event => {
      if (upstream !== ws) return;
      if (upstreamReady) armUpstreamTimer(ws, staleMs, `no message from the gateway for ${staleMs} ms`);
      if (typeof event.data !== 'string') return;
      const text = event.data;
      const msg = parseObject(text);
      if (!msg) return;
      if (msg.type === 'sdk_connected') {
        if (!upstreamReady) {
          upstreamReady = true;
          refusals = 0;
          lastError = null;
          log(`connected to the gateway (${route()})`);
          armUpstreamTimer(ws, staleMs, `no message from the gateway for ${staleMs} ms`);
        }
        lastConnected = text;
        sendToBox(text);
        return;
      }
      if (msg.type === 'sdk_error') {
        // An answer to the proxy's own sdk_connect is a refused login. It never reaches the box.
        if (upstreamReady) {
          // The gateway also answers a refused action with sdk_error and its actionId
          // (gateway.ts: "Bot not connected"). That action is no longer in flight.
          const id = msg.actionId;
          if ((typeof id === 'string' || typeof id === 'number') && inFlight.delete(actionKey(id))) notifyIdle();
          if (typeof msg.error === 'string' && msg.error.includes(PREEMPT_TEXT)) {
            sendToBox(JSON.stringify({ ...msg, error: PREEMPT_RELAY_TEXT }));
          } else sendToBox(text);
        } else dropUpstream(ws, `the gateway refused the login: ${errorText(msg.error, opts.password)}`, true);
        return;
      }
      if (!RELAYED_TYPES.has(msg.type as string)) return;
      if (msg.type === 'sdk_action_result' && inFlight.delete(actionKey(msg.actionId))) notifyIdle();
      if (msg.type === 'sdk_state' && opts.onState) {
        try { opts.onState(msg.state, now()); } catch { /* a failing tap must not stop the relay */ }
      }
      sendToBox(text, msg.type === 'sdk_state');
    };
    ws.onclose = () => dropUpstream(ws, 'the gateway connection closed', false);
  }

  const handleBoxMessage = (ws: ServerWebSocket<BoxData>, raw: string | Buffer) => {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_BOX_MESSAGE_BYTES) { ws.close(); return; }
    const msg = parseObject(raw);
    if (!msg) { ws.close(); return; }

    if (!ws.data.authed) {
      const ok = msg.type === 'sdk_connect'
        && typeof msg.password === 'string' && tokenEquals(msg.password, opts.bootToken)
        && msg.username === opts.account;
      const refusal = !ok ? 'unauthorized' : lastConnected === null ? 'upstream not ready' : null;
      if (refusal) {
        ws.send(JSON.stringify({ type: 'sdk_error', error: refusal }));
        ws.close();
        return;
      }
      clearHandshakeTimer(ws);
      ws.data.authed = true;
      const old = box;
      box = ws;
      if (old && old !== ws) old.close();
      ws.send(lastConnected as string);
      return;
    }

    if (ws !== box || msg.type !== 'sdk_action') return;
    // The gateway check comes first: the policy counts each chat action that it allows, and an
    // action that cannot go out must not use up the chat limit.
    if (!upstream || !upstreamReady) {
      ws.send(JSON.stringify({ type: 'sdk_action_result', actionId: msg.actionId, result: { success: false, message: 'upstream not connected' } }));
      return;
    }
    const verdict = opts.policy.check(msg.action, { jobActive, nowMs: now() });
    if (verdict.allow) {
      inFlight.set(actionKey(msg.actionId), now());
      upstream.send(JSON.stringify(rebuildAction(msg)));
      return;
    }
    ws.send(JSON.stringify({ type: 'sdk_action_result', actionId: msg.actionId, result: { success: false, message: `blocked by policy: ${verdict.reason}` } }));
  };

  const clearHandshakeTimer = (ws: ServerWebSocket<BoxData>) => {
    if (ws.data.handshakeTimer) { clearTimeout(ws.data.handshakeTimer); ws.data.handshakeTimer = null; }
  };

  const server = Bun.serve<BoxData>({
    hostname: '127.0.0.1',
    port: opts.listenPort,
    fetch(req, srv) {
      if (req.headers.get('origin') !== null) return new Response('forbidden', { status: 403 });
      if (srv.upgrade(req, { data: { authed: false, handshakeTimer: null } })) return undefined;
      return new Response('upgrade required', { status: 426 });
    },
    websocket: {
      maxPayloadLength: MAX_BOX_MESSAGE_BYTES,
      // A hard cap above the state drop limit: action results still pass the drop limit, but a box
      // that never reads is closed before its buffer grows without bound.
      backpressureLimit: 2 * BOX_BUFFER_LIMIT_BYTES,
      closeOnBackpressureLimit: true,
      open(ws) {
        ws.data.handshakeTimer = setTimeout(() => { ws.data.handshakeTimer = null; if (!ws.data.authed) ws.close(); }, handshakeTimeoutMs);
      },
      message: handleBoxMessage,
      close(ws) { clearHandshakeTimer(ws); // The job flag stays: the SDK in the box reconnects by itself during a job. The job runner
      // turns the flag off when the job ends.
      if (box === ws) { box = null; droppingState = false; } },
    },
  });

  connectUpstream();

  return {
    port: server.port as number,
    setJobActive(active) { jobActive = active; },
    upstreamConnected: () => upstreamReady && upstream?.readyState === WebSocket.OPEN,
    actionsInFlight: countInFlight,
    waitIdle(timeoutMs) {
      if (countInFlight() === 0) return Promise.resolve(true);
      const ms = Math.min(Math.max(0, timeoutMs), WAIT_IDLE_CAP_MS);
      return new Promise<boolean>(resolve => {
        let timer: unknown = null;
        const done = (idle: boolean) => {
          idleWaiters.delete(waiter);
          if (timer !== null) timers.clearTimeout(timer);
          resolve(idle);
        };
        const waiter = () => done(true);
        idleWaiters.add(waiter);
        timer = timers.setTimeout(() => { timer = null; done(countInFlight() === 0); }, ms);
      });
    },
    status: () => ({ connected: upstreamReady && upstream?.readyState === WebSocket.OPEN, lastError, reconnects: Math.max(0, attempts - 1), gateway: route() }),
    reconnect() {
      if (stopped) return;
      if (reconnectTimer !== null) { timers.clearTimeout(reconnectTimer); reconnectTimer = null; }
      useDirect = directUrl !== null;
      refusals = 0;
      const ws = upstream;
      if (ws) {
        upstream = null;
        upstreamReady = false;
        clearUpstreamTimer();
        inFlight.clear();
        notifyIdle();
        try { ws.close(); } catch { /* already closed */ }
      }
      log('reconnect to the gateway requested');
      connectUpstream();
    },
    async stop() {
      stopped = true;
      if (reconnectTimer !== null) { timers.clearTimeout(reconnectTimer); reconnectTimer = null; }
      clearUpstreamTimer();
      const ws = upstream;
      upstream = null;
      upstreamReady = false;
      ws?.close();
      inFlight.clear();
      notifyIdle();
      // Not awaited: on Bun 1.3.14 (Windows) the promise never settles after the server closed a
      // WebSocket itself. The listener and all connections close synchronously.
      void server.stop(true);
    },
  };
}
