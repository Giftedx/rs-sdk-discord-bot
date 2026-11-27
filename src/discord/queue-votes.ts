// Queue votes without commands: a thumbs-up on a waiting request moves it up one place,
// at most once per member per request.
import { errText, type Logger } from './types';

/** The thumbs-up emoji with or without a skin tone. */
export function isThumbsUp(emoji: string | null | undefined): boolean {
  return typeof emoji === 'string' && /^\u{1F44D}[\u{1F3FB}-\u{1F3FF}]?️?$/u.test(emoji);
}

/** The waiting ids in order, with `id` one place earlier. Unchanged when `id` is first or absent. */
export function moveUpOne(order: readonly number[], id: number): number[] {
  const out = [...order];
  const i = out.indexOf(id);
  if (i > 0) [out[i - 1], out[i]] = [out[i]!, out[i - 1]!];
  return out;
}

/** What the reaction event gives the hook. The adapter fills it from discord.js. */
export interface ReactionInput {
  messageId: string;
  userId: string;
  userIsBot: boolean;
  emoji: string | null;
}

export interface QueueVotesOptions {
  /** The id of the waiting request that this message started, or null. */
  requestFor(messageId: string): number | null;
  /** True when the member may talk to the bot. */
  mayTalk(userId: string): boolean | Promise<boolean>;
  /** The ids of the waiting requests, first to run first. */
  waitingOrder(): number[];
  /** Stores the new order of the waiting requests. */
  setOrder(ids: number[]): void;
  log: Logger;
}

export class QueueVotes {
  private votes = new Map<number, Set<string>>();

  constructor(private readonly o: QueueVotesOptions) {}

  /** Returns true when the request moved up. */
  async onReaction(r: ReactionInput): Promise<boolean> {
    if (r.userIsBot || !isThumbsUp(r.emoji)) return false;
    try {
      const id = this.o.requestFor(r.messageId);
      if (id === null) return false;
      const order = this.o.waitingOrder();
      this.forgetGone(order);
      if (!order.includes(id)) return false;
      const seen = this.votes.get(id) ?? new Set<string>();
      if (seen.has(r.userId)) return false;
      // Reserve the vote before the await, so that two quick reactions of one member count once.
      seen.add(r.userId);
      this.votes.set(id, seen);
      let ok = false;
      try { ok = await this.o.mayTalk(r.userId); } finally { if (!ok) seen.delete(r.userId); }
      if (!ok) return false;
      // Read the order again: it can change while mayTalk waits.
      const now = this.o.waitingOrder();
      const next = moveUpOne(now, id);
      if (next.every((x, i) => x === now[i])) return false;
      this.o.setOrder(next);
      return true;
    } catch (err) {
      this.o.log(`queue vote failed: ${errText(err)}`);
      return false;
    }
  }

  private forgetGone(order: number[]): void {
    for (const id of this.votes.keys()) if (!order.includes(id)) this.votes.delete(id);
  }
}
