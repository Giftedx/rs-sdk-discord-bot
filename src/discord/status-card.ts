// One pinned status message per guild. It is edited on a timer only while an instruction runs.
import { sanitizeForDiscord } from '../shared/sanitize';
import { errText, type Handle, type Logger, type Timers } from './types';

export const CARD_MARKER = '[status card]';
export const STATUS_ID = 'status';
export const CARD_INTERVAL_MS = 15_000;
export const XP_RATE_WINDOW_MS = 15 * 60_000;
const MIN_RATE_SPAN_MS = 60_000;

/** One stored snapshot of the skills. */
export interface SkillSample {
  time: number;
  skills: Record<string, { level: number; xp: number }>;
}

export interface CardView {
  goal: string;
  step: string;
  hp: { hp: number; maxHp: number } | null;
  queueLength: number;
  spend: { usedUsd: number; capUsd: number };
  running: boolean;
  /** A short reason, for example "spend cap reached". */
  note?: string;
  /** A PNG frame from the game tab. */
  frame?: Uint8Array;
  /** Used inventory slots. The game has 28. */
  inventory?: { used: number; max: number };
  /** Skill snapshots; the card uses the last 15 minutes for the current skill and its XP per hour. */
  xpSamples?: SkillSample[];
  /** The text of the last event. */
  lastEvent?: string;
  /** The name of the running script. */
  script?: string;
}

export interface CardMessage {
  content: string;
  frame?: Uint8Array;
  /** A button with url is a link button and sends no interaction. */
  buttons: { id: string; label: string; danger?: boolean; url?: string }[];
}

/** The part of a Discord channel the card needs. fetchPinned returns only the messages of this bot. */
export interface CardChannel {
  fetchPinned(): Promise<{ id: string; content: string }[]>;
  send(msg: CardMessage): Promise<string>;
  edit(id: string, msg: CardMessage): Promise<void>;
  pin(id: string): Promise<void>;
}

export interface StatusCardOptions {
  channel: CardChannel;
  view: () => CardView | Promise<CardView>;
  secrets: string[];
  timers: Timers;
  log: Logger;
  intervalMs?: number;
}

/** The skill with the most XP gained in the last 15 minutes of samples, and its XP per hour. */
export function currentSkill(samples: SkillSample[], windowMs = XP_RATE_WINDOW_MS): { name: string; level: number; xpPerHour: number } | null {
  if (samples.length < 2) return null;
  const sorted = [...samples].sort((a, b) => a.time - b.time);
  const last = sorted.at(-1)!;
  const first = sorted.find((s) => s.time >= last.time - windowMs)!;
  const span = last.time - first.time;
  if (span < MIN_RATE_SPAN_MS) return null;
  let best: { name: string; level: number; gain: number } | null = null;
  for (const [name, k] of Object.entries(last.skills)) {
    const gain = k.xp - (first.skills[name]?.xp ?? k.xp);
    if (gain > 0 && (!best || gain > best.gain)) best = { name, level: k.level, gain };
  }
  return best ? { name: best.name, level: best.level, xpPerHour: Math.round((best.gain * 3_600_000) / span) } : null;
}

export function renderCard(v: CardView, secrets: string[]): CardMessage {
  const hp = v.hp ? `${v.hp.hp}/${v.hp.maxHp}` : '?';
  // A long goal or step must not push the queue, spend and warning lines off the card.
  // Hide the secrets first, then cut: a cut through a secret would leave a part that no longer matches.
  const cap = (s: string | null | undefined, n = 200) => {
    if (!s) return s ?? null;
    const r = sanitizeForDiscord(s, secrets, Number.MAX_SAFE_INTEGER);
    return r.length > n ? `${r.slice(0, n - 1)}…` : r;
  };
  const lines = [`**Status** ${CARD_MARKER}`];
  // The mode follows the work: the bot keeps a goal text also while it waits.
  if (v.running) {
    const step = cap(v.step) || 'working';
    const goal = cap(v.goal);
    const script = cap(v.script, 60);
    lines.push(`▶️ ${goal ? `**${goal}**: ` : ''}${step}${script ? ` (script \`${script}\`)` : ''}`);
  } else {
    lines.push('💤 Idle. Talk to me in this channel in plain words, for example "chop some trees" or "what are you doing?".');
  }
  const stats = [`❤️ HP ${hp}`];
  if (v.inventory) stats.push(`🎒 ${v.inventory.used}/${v.inventory.max}`);
  const skill = v.xpSamples ? currentSkill(v.xpSamples) : null;
  if (skill) stats.push(`⭐ ${skill.name} ${skill.level} (+${skill.xpPerHour.toLocaleString('en-US')} xp/h)`);
  lines.push(stats.join(' · '));
  if (v.lastEvent) lines.push(`🕑 Last: ${v.lastEvent}`);
  lines.push(`📋 Queue: ${v.queueLength === 0 ? 'empty' : `${v.queueLength} waiting`} · 💰 $${v.spend.usedUsd.toFixed(2)} of $${v.spend.capUsd.toFixed(2)} this month`);
  if (v.note) lines.push(`⚠️ ${cap(v.note, 300)}`);
  const buttons: CardMessage['buttons'] = [{ id: STATUS_ID, label: 'Status' }];
  return {
    content: sanitizeForDiscord(lines.join('\n'), secrets),
    frame: v.frame,
    buttons,
  };
}

export class StatusCard {
  private id: string | null = null;
  private timer: Handle | null = null;
  private busy: Promise<void> | null = null;
  private again = false;
  private warned = new Set<string>();
  private readonly intervalMs: number;

  constructor(private readonly o: StatusCardOptions) {
    this.intervalMs = o.intervalMs ?? CARD_INTERVAL_MS;
  }

  get messageId(): string | null {
    return this.id;
  }

  /** Finds the card of an earlier run by its marker, or sends and pins a new card. */
  async init(): Promise<void> {
    try {
      const pinned = await this.o.channel.fetchPinned();
      const old = pinned.find((m) => m.content.includes(CARD_MARKER));
      if (old) this.id = old.id;
    } catch (err) {
      this.warnOnce('fetch', `status card: cannot read pinned messages: ${errText(err)}`);
    }
    await this.update();
  }

  instructionStarted(): Promise<void> {
    if (this.timer === null) this.timer = this.o.timers.setInterval(() => void this.update(), this.intervalMs);
    return this.update();
  }

  instructionEnded(): Promise<void> {
    this.stopTimer();
    return this.update();
  }

  stopTimer(): void {
    if (this.timer !== null) this.o.timers.clearInterval(this.timer);
    this.timer = null;
  }

  get ticking(): boolean {
    return this.timer !== null;
  }

  /** Edits the card now. A call during an edit runs once more after it, never in parallel. */
  update(): Promise<void> {
    if (this.busy) {
      this.again = true;
      return this.busy;
    }
    this.busy = (async () => {
      do {
        this.again = false;
        await this.write();
      } while (this.again);
    })().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async write(): Promise<void> {
    let msg: CardMessage;
    try {
      msg = renderCard(await this.o.view(), this.o.secrets);
    } catch (err) {
      this.warnOnce('view', `status card: cannot build the view: ${errText(err)}`);
      return;
    }
    if (this.id) {
      try {
        await this.o.channel.edit(this.id, msg);
        return;
      } catch (err) {
        // Only a deleted card gets a new one. Other errors (a 5xx, a reset, a timeout) keep the
        // card, and the next edit tries again: a new card for each error would fill the pins.
        if (!cardIsGone(err)) {
          this.warnOnce('edit-retry', `status card: edit failed, the next edit tries again: ${errText(err)}`);
          return;
        }
        this.warnOnce('edit', `status card: the card is gone, sending a new card: ${errText(err)}`);
        this.id = null;
      }
    }
    try {
      this.id = await this.o.channel.send(msg);
    } catch (err) {
      this.warnOnce('send', `status card: send failed: ${errText(err)}`);
      return;
    }
    try {
      await this.o.channel.pin(this.id);
    } catch (err) {
      this.warnOnce('pin', `status card: pin failed (missing permission?): ${errText(err)}`);
    }
  }

  private warnOnce(key: string, line: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.o.log(line);
  }
}

// Discord's "Unknown Message" (code 10008): the card was deleted.
export function cardIsGone(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  return e?.code === 10008 || (typeof e?.message === 'string' && e.message.includes('Unknown Message'));
}
