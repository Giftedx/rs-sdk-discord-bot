// A thread with the frame (or the portrait) of each level milestone and each death. No pings, a cap per hour.
import type { GameEvent } from '../events/diff';
import { sanitizeForDiscord } from '../shared/sanitize';
import { logLine, type LogThread, type LogThreadHost } from './adventure-log';
import { isMilestone } from './posts';
import { errText, type Logger, type Timers } from './types';

export const GALLERY_THREAD_NAME = 'gallery';
export const GALLERY_MAX_PER_HOUR = 6;
const HOUR = 3_600_000;

export interface GalleryOptions {
  host: LogThreadHost;
  secrets: string[];
  timers: Timers;
  log: Logger;
  /** The newest game frame as a PNG, or null. */
  frame: () => Promise<Uint8Array | null>;
  /** Used when there is no frame, for example a drawn character picture. */
  portrait?: () => Promise<Uint8Array | null>;
  name?: string;
  maxPerHour?: number;
  /** Default true. */
  silent?: boolean;
}

/** True for the events that get a picture: a level milestone or a death. */
export function isGalleryEvent(e: GameEvent): boolean {
  return e.kind === 'death' || (e.kind === 'level_up' && isMilestone(e));
}

export class Gallery {
  // One promise for the thread, so that events at the same moment find or make one thread.
  private thread: Promise<LogThread> | null = null;
  private sent: number[] = [];

  constructor(private readonly o: GalleryOptions) {}

  /** Posts a picture for a milestone or a death. Returns true if a post went out. */
  async onEvent(e: GameEvent): Promise<boolean> {
    if (!isGalleryEvent(e)) return false;
    const now = this.o.timers.now();
    this.sent = this.sent.filter((t) => t > now - HOUR);
    const max = this.o.maxPerHour ?? GALLERY_MAX_PER_HOUR;
    if (this.sent.length >= max) {
      this.o.log(`gallery: hourly cap of ${max} reached, picture dropped`);
      return false;
    }
    try {
      const png = (await this.o.frame().catch(() => null)) ?? (await this.o.portrait?.().catch(() => null)) ?? null;
      if (!png) return false;
      this.sent.push(now);
      const name = this.o.name ?? GALLERY_THREAD_NAME;
      this.thread ??= this.o.host.findThread(name).then(t => t ?? this.o.host.createThread(name));
      const thread = await this.thread;
      await thread.send(sanitizeForDiscord(logLine(e), this.o.secrets), { png, silent: this.o.silent ?? true });
      return true;
    } catch (err) {
      this.thread = null;
      this.o.log(`gallery: send failed: ${errText(err)}`);
      return false;
    }
  }
}
