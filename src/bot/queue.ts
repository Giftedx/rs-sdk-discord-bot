// The instruction queue: one instruction runs at a time, the others wait in order.
export interface Instruction {
  id: number;
  userId: string;
  userName: string;
  text: string;
}

export type AddResult =
  | { ok: true; position: number; item: Instruction }
  | { ok: false; reason: 'full' | 'cooldown' | 'empty' | 'too_long' };

export const MAX_INSTRUCTION_CHARS = 1_000;

export function createQueue(opts: { max: number; userCooldownMs: number; now?: () => number }) {
  const now = opts.now ?? Date.now;
  const waiting: Instruction[] = [];
  const lastByUser = new Map<string, number>();
  let nextId = 1;
  let current: Instruction | null = null;

  return {
    add(userId: string, userName: string, text: string): AddResult {
      const t = text.trim();
      if (t === '') return { ok: false, reason: 'empty' };
      if (t.length > MAX_INSTRUCTION_CHARS) return { ok: false, reason: 'too_long' };
      const last = lastByUser.get(userId);
      if (last !== undefined && now() - last < opts.userCooldownMs) return { ok: false, reason: 'cooldown' };
      if (waiting.length >= opts.max) return { ok: false, reason: 'full' };
      const item = { id: nextId++, userId, userName, text: t };
      waiting.push(item);
      lastByUser.set(userId, now());
      return { ok: true, position: waiting.length + (current ? 1 : 0), item };
    },
    // Takes the next instruction if none runs.
    next(): Instruction | null {
      if (current || waiting.length === 0) return null;
      current = waiting.shift()!;
      return current;
    },
    done(): void { current = null; },
    current: () => current,
    waiting: () => [...waiting],
    clear(): number { const n = waiting.length; waiting.length = 0; return n; },
  };
}

export type Queue = ReturnType<typeof createQueue>;
