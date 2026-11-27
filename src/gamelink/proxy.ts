import type { ServerWebSocket } from 'bun';
import { timingSafeEqual } from 'node:crypto';
import type { ActionPolicy } from './policy';

export interface ProxyOptions {
  upstreamUrl: string;              // gateway WebSocket URL
  account: string;
  password: string;                 // real game password, used only upstream
  bootToken: string;                // the box sends this in the `password` field of sdk_connect
  listenPort: number;               // 0 picks a free port
  policy: ActionPolicy;
  onState?: (state: unknown, receivedAtMs: number) => void;   // the state tap
  reconnectDelayMs?: () => number;  // default: 11_000 + random 0..5_000
  now?: () => number;
  handshakeTimeoutMs?: number;      // default 5000: a box socket without a valid sdk_connect by then is closed
}

export interface ProxyHandle {
  port: number;
  setJobActive(active: boolean): void;
  upstreamConnected(): boolean;
  stop(): Promise<void>;
}

const MAX_BOX_MESSAGE_BYTES = 65_536;
const RELAYED_TYPES: ReadonlySet<string> = new Set(['sdk_state', 'sdk_action_result', 'sdk_info']);

interface BoxData { authed: boolean; handshakeTimer: ReturnType<typeof setTimeout> | null; }

const defaultReconnectDelayMs = () => 11_000 + Math.floor(Math.random() * 5_001);

function tokenEquals(given: string, expected: string): boolean {
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // timingSafeEqual needs equal lengths; compare b with itself so the work does not depend on `given`.
  if (a.length !== b.length) return timingSafeEqual(b, b) && false;
  return timingSafeEqual(a, b);
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
  const reconnectDelayMs = opts.reconnectDelayMs ?? defaultReconnectDelayMs;
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 5_000;

  let stopped = false;
  let jobActive = false;
  let upstream: WebSocket | null = null;
  let upstreamReady = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastConnected: string | null = null;   // last upstream sdk_connected, as received
  let lastInfo: string | null = null;        // last upstream sdk_info, as received
  let box: ServerWebSocket<BoxData> | null = null;

  const sendToBox = (text: string) => { if (box && box.data.authed) box.send(text); };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectUpstream(); }, reconnectDelayMs());
  };

  function connectUpstream() {
    if (stopped || upstream) return;
    const ws = new WebSocket(opts.upstreamUrl);
    upstream = ws;
    upstreamReady = false;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'sdk_connect', username: opts.account, password: opts.password, mode: 'control', clientId: 'gamelink-proxy' }));
    };
    ws.onmessage = event => {
      if (upstream !== ws || typeof event.data !== 'string') return;
      const text = event.data;
      const msg = parseObject(text);
      if (!msg) return;
      if (msg.type === 'sdk_connected') {
        lastConnected = text;
        upstreamReady = true;
        sendToBox(text);
        return;
      }
      if (msg.type === 'sdk_error') {
        // An answer to the proxy's own sdk_connect counts as a closed connection:
        // onclose waits reconnectDelayMs(). It never reaches the box.
        if (upstreamReady) sendToBox(text); else ws.close();
        return;
      }
      if (!RELAYED_TYPES.has(msg.type as string)) return;
      if (msg.type === 'sdk_info') lastInfo = text;
      if (msg.type === 'sdk_state' && opts.onState) {
        try { opts.onState(msg.state, now()); } catch { /* a failing tap must not stop the relay */ }
      }
      sendToBox(text);
    };
    ws.onclose = () => {
      if (upstream !== ws) return;
      upstream = null;
      upstreamReady = false;
      scheduleReconnect();
    };
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
    const verdict = opts.policy.check(msg.action, { jobActive, nowMs: now() });
    if (verdict.allow && upstream && upstreamReady) {
      upstream.send(JSON.stringify(msg));
      return;
    }
    const message = verdict.allow ? 'upstream not connected' : `blocked by policy: ${verdict.reason}`;
    ws.send(JSON.stringify({ type: 'sdk_action_result', actionId: msg.actionId, result: { success: false, message } }));
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
      open(ws) {
        ws.data.handshakeTimer = setTimeout(() => { ws.data.handshakeTimer = null; if (!ws.data.authed) ws.close(); }, handshakeTimeoutMs);
      },
      message: handleBoxMessage,
      close(ws) { clearHandshakeTimer(ws); if (box === ws) box = null; },
    },
  });

  connectUpstream();

  return {
    port: server.port as number,
    setJobActive(active) { jobActive = active; },
    upstreamConnected: () => upstreamReady && upstream?.readyState === WebSocket.OPEN,
    async stop() {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      const ws = upstream;
      upstream = null;
      upstreamReady = false;
      ws?.close();
      // Not awaited: on Bun 1.3.14 (Windows) the promise never settles after the server closed a
      // WebSocket itself. The listener and all connections close synchronously.
      void server.stop(true);
    },
  };
}
