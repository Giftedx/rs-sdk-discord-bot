// Protections that run inside every job. The job runner imports this file into the job and
// starts it before the job body. A timer reads the state about every 600 ms:
// - at HP <= 40% it eats the inventory food that heals the most;
// - at HP <= 25% with no food it walks away from the attacker.
// The job body can call protections.off(), protections.on() or protections.status().
// This file has no runtime import, so the box user can load it without the bot modules.
import type { InventoryItem, NearbyNpc, PlayerState } from '../../vendor/rs-sdk/sdk/types';

export interface ProtectionBot {
  eatFood(target?: InventoryItem | string | RegExp): Promise<{ success: boolean; hpGained: number; message: string }>;
}

export interface ProtectionSdk {
  getState(): { player: PlayerState | null } | null;
  getInventory(): InventoryItem[];
  getNearbyNpc(index: number): NearbyNpc | null;
  getNearbyNpcs(): NearbyNpc[];
  sendWalk(x: number, z: number, running?: boolean): Promise<{ success: boolean; message?: string }>;
}

export interface ProtectionOptions {
  intervalMs?: number;
  eatAtPct?: number;          // 0..1
  fleeAtPct?: number;         // 0..1
  fleeTiles?: number;
  fleeEveryMs?: number;       // minimum time between two flee walks
  log?: (line: string) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Protections {
  off(): void;
  on(): void;
  stop(): void;               // the runner calls this when the job ends
  status(): { enabled: boolean; eats: number; flees: number };
  tick(): Promise<void>;      // one check; the timer calls it
}

// Hitpoints that a food item restores. A food that is not in this table counts as 1.
export const FOOD_HEAL: Record<string, number> = {
  anchovies: 1, shrimps: 3, 'cooked chicken': 3, 'cooked meat': 3, 'cooked rabbit': 5, bread: 5,
  sardine: 4, herring: 5, mackerel: 6, trout: 7, cod: 7, pike: 8, salmon: 9, tuna: 10,
  lobster: 12, bass: 13, swordfish: 14, monkfish: 16, shark: 20, 'sea turtle': 21, 'manta ray': 22,
  cake: 4, '2/3 cake': 4, 'slice of cake': 4, 'chocolate cake': 5, 'meat pie': 6, 'half a meat pie': 6,
  'plain pizza': 7, '1/2 plain pizza': 7, 'meat pizza': 8, '1/2 meat pizza': 8, potato: 1, onion: 1, cabbage: 1,
};

const canEat = (item: InventoryItem) => item.optionsWithIndex.some(o => /^eat$/i.test(o.text));

export function bestFood(items: InventoryItem[]): InventoryItem | null {
  let best: InventoryItem | null = null;
  let bestHeal = -1;
  for (const item of items) {
    if (!canEat(item)) continue;
    const heal = FOOD_HEAL[item.name.toLowerCase()] ?? 1;
    if (heal > bestHeal) { best = item; bestHeal = heal; }
  }
  return best;
}

// The NPC that fights the player: our own target, else the nearest NPC in combat next to us.
export function findAttacker(player: PlayerState, sdk: Pick<ProtectionSdk, 'getNearbyNpc' | 'getNearbyNpcs'>): NearbyNpc | null {
  if (player.combat?.targetType === 'npc' && player.combat.targetIndex >= 0) {
    const npc = sdk.getNearbyNpc(player.combat.targetIndex);
    if (npc) return npc;
  }
  const close = sdk.getNearbyNpcs().filter(n => n.inCombat && n.distance <= 2).sort((a, b) => a.distance - b.distance);
  return close[0] ?? null;
}

// A tile `tiles` away from the attacker, on the line from the attacker through the player.
export function fleeTarget(player: { worldX: number; worldZ: number }, attacker: { x: number; z: number } | null, tiles: number): { x: number; z: number } {
  let dx = attacker ? player.worldX - attacker.x : 1;
  let dz = attacker ? player.worldZ - attacker.z : 0;
  if (dx === 0 && dz === 0) dx = 1;
  const len = Math.hypot(dx, dz);
  return { x: Math.round(player.worldX + (dx / len) * tiles), z: Math.round(player.worldZ + (dz / len) * tiles) };
}

export function startProtections(bot: ProtectionBot, sdk: ProtectionSdk, opts: ProtectionOptions = {}): Protections {
  const intervalMs = opts.intervalMs ?? 600;
  const eatAt = opts.eatAtPct ?? 0.4;
  const fleeAt = opts.fleeAtPct ?? 0.25;
  const fleeTiles = opts.fleeTiles ?? 10;
  const fleeEveryMs = opts.fleeEveryMs ?? 4_000;
  const log = opts.log ?? ((line: string) => console.log(line));
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? ((fn, ms) => { const t = setInterval(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
  const clearTimer = opts.clearTimer ?? (h => clearInterval(h as ReturnType<typeof setInterval>));

  let enabled = true;
  let busy = false;
  let errorShown = false;
  let eats = 0;
  let flees = 0;
  let lastFleeAt = -Infinity;
  let noFoodShown = false;

  const tick = async () => {
    if (!enabled || busy) return;
    busy = true;
    try {
      const player = sdk.getState()?.player;
      if (!player || player.isDead || !(player.maxHp > 0)) return;
      const pct = player.hp / player.maxHp;
      if (pct > eatAt) return;
      const food = bestFood(sdk.getInventory());
      if (food) {
        const r = await bot.eatFood(food);
        if (r.success) eats++;
        log(`[protections] HP ${player.hp}/${player.maxHp}: ate ${food.name} (${r.success ? `+${r.hpGained}` : r.message})`);
        return;
      }
      if (pct > fleeAt) return;
      if (!noFoodShown) { noFoodShown = true; log(`[protections] HP ${player.hp}/${player.maxHp} and no food`); }
      if (now() - lastFleeAt < fleeEveryMs) return;
      const attacker = findAttacker(player, sdk);
      if (!attacker && !player.combat?.inCombat) return;
      lastFleeAt = now();
      const to = fleeTarget(player, attacker, fleeTiles);
      await sdk.sendWalk(to.x, to.z, true);
      flees++;
      log(`[protections] HP ${player.hp}/${player.maxHp}: ran from ${attacker?.name ?? 'combat'} to (${to.x}, ${to.z})`);
    } catch (err) {
      if (!errorShown) {
        errorShown = true;
        log(`[protections] error (shown once): ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      busy = false;
    }
  };

  let handle: unknown = setTimer(() => { void tick(); }, intervalMs);
  const stop = () => { if (handle !== null) { clearTimer(handle); handle = null; } };

  return {
    off: () => { enabled = false; },
    on: () => { enabled = true; },
    stop: () => { enabled = false; stop(); },
    status: () => ({ enabled, eats, flees }),
    tick,
  };
}
