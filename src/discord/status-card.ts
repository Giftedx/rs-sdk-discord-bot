// One pinned status message per guild. It is edited on a timer only while an instruction runs.
import { sanitizeForDiscord } from '../shared/sanitize';
import { errText, type Handle, type Logger, type Timers } from './types';

export const CARD_MARKER = '[status card]';
export const STOP_ID = 'stop';
export const STATUS_ID = 'status';
export const CARD_INTERVAL_MS = 15_000;

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
}

export interface CardMessage {
  content: string;
  frame?: Uint8Array;
  buttons: { id: string; label: string; danger?: boolean }[];
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

export function renderCard(v: CardView, secrets: string[]): CardMessage {
  const hp = v.hp ? `${v.hp.hp}/${v.hp.maxHp}` : 'unknown';
  const lines = [
    `**Status** ${CARD_MARKER}`,
    `Goal: ${v.goal || 'none'}`,
    `Step: ${v.step || (v.running ? 'working' : 'waiting')}`,
    `HP: ${hp}`,
    `Queue: ${v.queueLength}`,
    `Budget this month: $${v.spend.usedUsd.toFixed(2)} of $${v.spend.capUsd.toFixed(2)}`,
  ];
  if (v.note) lines.push(`Note: ${v.note}`);
  return {
    content: sanitizeForDiscord(lines.join('\n'), secrets),
    frame: v.frame,
    buttons: [
      { id: STOP_ID, label: 'Stop', danger: true },
      { id: STATUS_ID, label: 'Status' },
    ],
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
        // The card was deleted or cannot be edited; send a new one.
        this.warnOnce('edit', `status card: edit failed, sending a new card: ${errText(err)}`);
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
