// Rare posts in the main channel: level milestones, deaths, instruction receipts and a daily recap.
// A hard limit caps all of them per hour, the recap included.
import { xpChartData } from '../cards/xp-chart';
import type { XpChartCard } from '../cards/templates';
import { eventText, type GameEvent } from '../events/diff';
import { sanitizeForDiscord } from '../shared/sanitize';
import type { SkillSample } from './status-card';
import { errText, type Handle, type Logger, type Timers } from './types';

// The skill levels that get a post in the main channel. The demo world gives fast XP, so a post
// every 10 levels floods the channel. Settable with MILESTONE_LEVELS.
export const MILESTONE_LEVELS: readonly number[] = [10, 25, 50, 75, 90, 99];
export const DEFAULT_MAX_PER_HOUR = 4;
export const DEFAULT_MERGE_WINDOW_SEC = 60;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The adapter must send with allowedMentions { parse: [] }. */
export interface PostChannel {
  /** extra: more PNGs after png. silent: send with MessageFlags.SuppressNotifications. */
  send(content: string, png?: Uint8Array, opts?: { extra?: Uint8Array[]; silent?: boolean }): Promise<void>;
}

/** What a drawn card can show: one event, or the daily recap. */
export type CardSubject = GameEvent | { kind: 'recap'; recap: Recap };

/** One row of the events table: type is the event kind, data the GameEvent when it was stored. */
export interface StoredEvent {
  time: number;
  type: string;
  data?: unknown;
}

type LevelUp = Extract<GameEvent, { kind: 'level_up' }>;

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
  /** Level-ups within this time become one post. 0 posts each at once. */
  mergeWindowSec?: number;
  // The skill levels that get a post. Default MILESTONE_LEVELS.
  milestoneLevels?: readonly number[];
  /** Rows of the events table since a time in ms. With it the recap survives a restart. */
  eventsSince?: (sinceMs: number) => StoredEvent[];
  /** XP gained per skill since a time in ms, for example xpGains() of the stored snapshots. */
  xpGainedSince?: (sinceMs: number) => Record<string, number>;
  /** Skill samples since a time in ms. With drawChart the recap gets an XP chart of the last 24 hours. */
  xpSamplesSince?: (sinceMs: number) => SkillSample[];
  /** Draws the XP chart card. Null or an error sends the recap without it. */
  drawChart?: (data: XpChartCard) => Promise<Uint8Array | null>;
  /** Default false: main posts notify the members. */
  silent?: boolean;
  /** A close picture of the character. A death post attaches it after the card. */
  portrait?: () => Promise<Uint8Array | null>;
}

export interface Recap {
  levelUps: number;
  items: number;
  deaths: number;
  instructions: number;
  spendUsd: number | null;
  /** The count of events in the period. The recap is not posted when it is 0. */
  events?: number;
  /** XP gained per skill, most first. */
  xpBySkill?: { skill: string; xp: number }[];
}

/** XP gained per skill from the first to the last sample. */
export function xpGains(samples: SkillSample[]): Record<string, number> {
  if (samples.length < 2) return {};
  const sorted = [...samples].sort((a, b) => a.time - b.time);
  const first = sorted[0]!.skills;
  const last = sorted.at(-1)!.skills;
  const out: Record<string, number> = {};
  for (const [name, k] of Object.entries(last)) {
    const gain = k.xp - (first[name]?.xp ?? k.xp);
    if (gain > 0) out[name] = gain;
  }
  return out;
}

/** Joins level-ups of one burst: one entry per skill, from the lowest level to the highest. */
export function mergeLevelUps(list: LevelUp[]): LevelUp[] {
  const by = new Map<string, LevelUp>();
  for (const e of list) {
    const m = by.get(e.skill);
    by.set(e.skill, m ? { ...m, from: Math.min(m.from, e.from), level: Math.max(m.level, e.level) } : { ...e });
  }
  return [...by.values()];
}

// The highest milestone level that a level-up passed, or null.
export function passedMilestone(e: LevelUp, levels: readonly number[] = MILESTONE_LEVELS): number | null {
  let best: number | null = null;
  for (const m of levels) if (e.from < m && e.level >= m) best = best === null ? m : Math.max(best, m);
  return best;
}

function milestonePhrase(e: LevelUp, levels: readonly number[]): string {
  const m = passedMilestone(e, levels) ?? e.level;
  return m === e.level ? `${e.skill} ${e.level}` : `${e.skill} ${m} (now ${e.level})`;
}

function levelsText(list: LevelUp[], levels: readonly number[]): string {
  const hit = list.filter((e) => passedMilestone(e, levels) !== null);
  return `🎉 Milestone: ${hit.map((e) => milestonePhrase(e, levels)).join(', ')}!`;
}

export function isMilestone(e: GameEvent, levels: readonly number[] = MILESTONE_LEVELS): boolean {
  if (e.kind === 'level_up') return passedMilestone(e, levels) !== null;
  return e.kind === 'death' || e.kind === 'instruction_done';
}

export function postText(e: GameEvent, levels: readonly number[] = MILESTONE_LEVELS): string {
  if (e.kind === 'level_up') return `🎉 Milestone: ${milestonePhrase(e, levels)}!`;
  if (e.kind === 'instruction_done') return `Receipt: ${eventText(e)}`;
  return eventText(e);
}

export function recapText(r: Recap): string {
  const spend = r.spendUsd === null ? '' : `, spend $${r.spendUsd.toFixed(2)}`;
  const xp = r.xpBySkill && r.xpBySkill.length > 0 ? ` XP: ${r.xpBySkill.map((x) => `${x.skill} +${x.xp.toLocaleString('en-US')}`).join(', ')}.` : '';
  return `Last 24 hours: ${r.levelUps} level-ups, ${r.items} items, ${r.deaths} deaths, ${r.instructions} instructions${spend}.${xp}`;
}

function asEvent(row: StoredEvent): GameEvent | null {
  const d = row.data;
  if (typeof d !== 'object' || d === null || (d as { kind?: unknown }).kind !== row.type) return null;
  return d as GameEvent;
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
  private mergeTimer: Handle | null = null;
  private pendingLevels: LevelUp[] = [];
  // After stop(), a recap that was posting does not arm the next one.
  private stopped = false;
  private readonly maxPerHour: number;
  private readonly mergeMs: number;
  private readonly levels: readonly number[];

  constructor(private readonly o: MainPostsOptions) {
    this.maxPerHour = o.maxPerHour ?? DEFAULT_MAX_PER_HOUR;
    this.mergeMs = Math.max(0, (o.mergeWindowSec ?? DEFAULT_MERGE_WINDOW_SEC) * 1000);
    this.levels = o.milestoneLevels && o.milestoneLevels.length > 0 ? o.milestoneLevels : MILESTONE_LEVELS;
    if (o.recapHourUtc !== undefined && !(Number.isInteger(o.recapHourUtc) && o.recapHourUtc >= 0 && o.recapHourUtc <= 23)) {
      throw new Error('recapHourUtc must be an integer from 0 to 23');
    }
  }

  start(): void {
    if (this.stopped || this.o.recapHourUtc === undefined || this.recapTimer !== null) return;
    const hour = this.o.recapHourUtc;
    this.recapTimer = this.o.timers.setTimeout(() => {
      this.recapTimer = null;
      void this.postRecap().finally(() => this.start());
    }, msUntilUtcHour(this.o.timers.now(), hour));
  }

  /** Stops the timers. Level-ups that wait for the merge window are dropped; call flushLevels() first to post them. */
  stop(): void {
    this.stopped = true;
    if (this.recapTimer !== null) this.o.timers.clearTimeout(this.recapTimer);
    this.recapTimer = null;
    if (this.mergeTimer !== null) this.o.timers.clearTimeout(this.mergeTimer);
    this.mergeTimer = null;
    this.pendingLevels = [];
  }

  /**
   * Records the event for the recap and posts it when it is a milestone. Returns true if it was posted.
   * A level-up waits for the merge window and then returns false; the merged post follows.
   */
  async onEvent(e: GameEvent): Promise<boolean> {
    this.record(e);
    if (e.kind === 'level_up' && this.mergeMs > 0) {
      this.pendingLevels.push(e);
      if (this.mergeTimer === null) {
        this.mergeTimer = this.o.timers.setTimeout(() => {
          this.mergeTimer = null;
          void this.flushLevels();
        }, this.mergeMs);
      }
      return false;
    }
    if (!isMilestone(e, this.levels)) return false;
    const portrait = this.o.portrait;
    return this.post(postText(e, this.levels), e, e.kind === 'death' && portrait ? () => portrait() : undefined);
  }

  /** Posts the waiting level-ups as one post if one of them is a milestone. */
  flushLevels(): Promise<boolean> {
    if (this.mergeTimer !== null) this.o.timers.clearTimeout(this.mergeTimer);
    this.mergeTimer = null;
    const merged = mergeLevelUps(this.pendingLevels);
    this.pendingLevels = [];
    const first = merged.find((x) => isMilestone(x, this.levels));
    if (!first) return Promise.resolve(false);
    return this.post(levelsText(merged, this.levels), first);
  }

  /** Records the event for the recap only. For events that already have their own message. */
  record(e: GameEvent): void {
    const now = this.o.timers.now();
    this.events.push({ at: now, e });
    this.events = this.events.filter((x) => x.at > now - DAY);
  }

  recap(): Recap {
    const now = this.o.timers.now();
    const r: Recap = { levelUps: 0, items: 0, deaths: 0, instructions: 0, spendUsd: null, events: 0 };
    let rows: { type: string; e: GameEvent | null }[] | null = null;
    if (this.o.eventsSince) {
      try {
        rows = this.o.eventsSince(now - DAY).map((x) => ({ type: x.type, e: asEvent(x) }));
      } catch (err) {
        this.o.log(`posts: cannot read events, the recap uses the events since the start: ${errText(err)}`);
      }
    }
    rows ??= this.events.filter((x) => x.at > now - DAY).map((x) => ({ type: x.e.kind, e: x.e }));
    for (const { type, e } of rows) {
      r.events!++;
      if (type === 'level_up') r.levelUps += e?.kind === 'level_up' ? e.level - e.from : 1;
      else if (type === 'item_gain') r.items += e?.kind === 'item_gain' ? e.items.reduce((n, i) => n + i.count, 0) : 0;
      else if (type === 'death') r.deaths++;
      else if (type === 'instruction_done') r.instructions++;
    }
    if (this.o.xpGainedSince) {
      try {
        const xp = this.o.xpGainedSince(now - DAY);
        r.xpBySkill = Object.entries(xp).filter(([, n]) => n > 0).map(([skill, n]) => ({ skill, xp: n })).sort((a, b) => b.xp - a.xp);
      } catch (err) {
        this.o.log(`posts: cannot read xp: ${errText(err)}`);
      }
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

  /** Posts the recap, or nothing on a day with no events. */
  postRecap(): Promise<boolean> {
    const recap = this.recap();
    if (recap.events === 0) {
      this.o.log('posts: no events in the last 24 hours, recap skipped');
      return Promise.resolve(false);
    }
    return this.post(recapText(recap), { kind: 'recap', recap }, () => this.chart());
  }

  private async chart(): Promise<Uint8Array | null> {
    if (!this.o.xpSamplesSince || !this.o.drawChart) return null;
    const now = this.o.timers.now();
    const data = xpChartData(this.o.xpSamplesSince(now - DAY), now);
    return data ? this.o.drawChart(data) : null;
  }

  private async post(text: string, subject?: CardSubject, more?: () => Promise<Uint8Array | null>): Promise<boolean> {
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
      const extra = more ? await more().catch((err) => {
        this.o.log(`posts: extra picture not drawn: ${errText(err)}`);
        return null;
      }) : null;
      await this.o.channel.send(sanitizeForDiscord(text, this.o.secrets), png ?? undefined, { ...(extra ? { extra: [extra] } : {}), silent: this.o.silent ?? false });
      return true;
    } catch (err) {
      this.o.log(`posts: send failed: ${errText(err)}`);
      return false;
    }
  }
}
