// Rare posts in the main channel: level milestones, deaths, instruction receipts and a daily recap.
// A hard limit caps all of them per hour, the recap included.
import { eventText, type GameEvent } from '../events/diff';
import { sanitizeForDiscord } from '../shared/sanitize';
import { errText, type Handle, type Logger, type Timers } from './types';

export const SKILL_MILESTONE_STEP = 10;
export const DEFAULT_MAX_PER_HOUR = 4;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The adapter must send with allowedMentions { parse: [] }. */
export interface PostChannel {
  send(content: string, png?: Uint8Array): Promise<void>;
}

/** What a drawn card can show: one event, or the daily recap. */
export type CardSubject = GameEvent | { kind: 'recap'; recap: Recap };

export interface MainPostsOptions {
  channel: PostChannel;
  secrets: string[];
  timers: Timers;
  log: Logger;
  maxPerHour?: number;
  /** UTC hour (0-23) of the daily recap. Undefined turns the recap off. */
  recapHourUtc?: number;
  /** Spend in USD since a time in ms. */
  spendSince?: (sinceMs: number) => number;
  /** Draws a PNG card for a post. Null or an error sends the text alone. */
  draw?: (subject: CardSubject) => Promise<Uint8Array | null>;
}

export interface Recap {
  levelUps: number;
  items: number;
  deaths: number;
  instructions: number;
  spendUsd: number | null;
}

export function isMilestone(e: GameEvent): boolean {
  if (e.kind === 'level_up') return Math.floor(e.level / SKILL_MILESTONE_STEP) > Math.floor(e.from / SKILL_MILESTONE_STEP);
  return e.kind === 'death' || e.kind === 'instruction_done';
}

export function postText(e: GameEvent): string {
  if (e.kind === 'level_up') return `Milestone: ${e.skill} reached level ${e.level}.`;
  if (e.kind === 'instruction_done') return `Receipt: ${eventText(e)}`;
  return eventText(e);
}

export function recapText(r: Recap): string {
  const spend = r.spendUsd === null ? '' : `, spend $${r.spendUsd.toFixed(2)}`;
  return `Last 24 hours: ${r.levelUps} level-ups, ${r.items} items, ${r.deaths} deaths, ${r.instructions} instructions${spend}.`;
}

export function msUntilUtcHour(now: number, hour: number): number {
  const d = new Date(now);
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour);
  if (at <= now) at += DAY;
  return at - now;
}

export class MainPosts {
  private events: { at: number; e: GameEvent }[] = [];
  private sent: number[] = [];
  private recapTimer: Handle | null = null;
  private readonly maxPerHour: number;

  constructor(private readonly o: MainPostsOptions) {
    this.maxPerHour = o.maxPerHour ?? DEFAULT_MAX_PER_HOUR;
    if (o.recapHourUtc !== undefined && !(Number.isInteger(o.recapHourUtc) && o.recapHourUtc >= 0 && o.recapHourUtc <= 23)) {
      throw new Error('recapHourUtc must be an integer from 0 to 23');
    }
  }

  start(): void {
    if (this.o.recapHourUtc === undefined || this.recapTimer !== null) return;
    const hour = this.o.recapHourUtc;
    this.recapTimer = this.o.timers.setTimeout(() => {
      this.recapTimer = null;
      void this.postRecap().finally(() => this.start());
    }, msUntilUtcHour(this.o.timers.now(), hour));
  }

  stop(): void {
    if (this.recapTimer !== null) this.o.timers.clearTimeout(this.recapTimer);
    this.recapTimer = null;
  }

  /** Records the event for the recap and posts it when it is a milestone. Returns true if it was posted. */
  async onEvent(e: GameEvent): Promise<boolean> {
    this.record(e);
    if (!isMilestone(e)) return false;
    return this.post(postText(e), e);
  }

  /** Records the event for the recap only. For events that already have their own message. */
  record(e: GameEvent): void {
    const now = this.o.timers.now();
    this.events.push({ at: now, e });
    this.events = this.events.filter((x) => x.at > now - DAY);
  }

  recap(): Recap {
    const now = this.o.timers.now();
    const r: Recap = { levelUps: 0, items: 0, deaths: 0, instructions: 0, spendUsd: null };
    for (const { at, e } of this.events) {
      if (at <= now - DAY) continue;
      if (e.kind === 'level_up') r.levelUps += e.level - e.from;
      else if (e.kind === 'item_gain') r.items += e.items.reduce((n, i) => n + i.count, 0);
      else if (e.kind === 'death') r.deaths++;
      else if (e.kind === 'instruction_done') r.instructions++;
    }
    if (this.o.spendSince) {
      try {
        r.spendUsd = this.o.spendSince(now - DAY);
      } catch (err) {
        this.o.log(`posts: cannot read spend: ${errText(err)}`);
      }
    }
    return r;
  }

  postRecap(): Promise<boolean> {
    const recap = this.recap();
    return this.post(recapText(recap), { kind: 'recap', recap });
  }

  private async post(text: string, subject?: CardSubject): Promise<boolean> {
    const now = this.o.timers.now();
    this.sent = this.sent.filter((t) => t > now - HOUR);
    if (this.sent.length >= this.maxPerHour) {
      this.o.log(`posts: hourly cap of ${this.maxPerHour} reached, post dropped`);
      return false;
    }
    this.sent.push(now);
    try {
      let png: Uint8Array | null = null;
      if (subject && this.o.draw) {
        png = await this.o.draw(subject).catch((err) => {
          this.o.log(`posts: card not drawn: ${errText(err)}`);
          return null;
        });
      }
      await this.o.channel.send(sanitizeForDiscord(text, this.o.secrets), png ?? undefined);
      return true;
    } catch (err) {
      this.o.log(`posts: send failed: ${errText(err)}`);
      return false;
    }
  }
}
