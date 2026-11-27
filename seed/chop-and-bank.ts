// Chop trees at Lumbridge and bank the logs at Draynor by the safe north route, until the time or trip limit
const MAX_MS = 13 * 60_000;
const MAX_TRIPS = 5;
const TREES = { x: 3195, z: 3220 };
const BANK = { x: 3092, z: 3243 };
// learnings/walking.md: stay north of z=3240 on the way west; a straight line meets aggressive NPCs.
const ROUTE_TO_BANK = [{ x: 3230, z: 3270 }, { x: 3150, z: 3250 }, BANK];
const ROUTE_TO_TREES = [{ x: 3150, z: 3250 }, { x: 3230, z: 3270 }, TREES];
const deadline = Date.now() + MAX_MS;
const logsHeld = () => sdk.getInventory().filter(i => /logs$/i.test(i.name)).length;
const fighting = () => !!sdk.getState()?.player?.combat?.inCombat;
let chopped = 0;
let banked = 0;
let trips = 0;
let fails = 0;

const hasAxe = () => !!sdk.findInventoryItem(/(^|[^k])axe$/i) || !!sdk.findEquipmentItem(/(^|[^k])axe$/i);
if (!hasAxe()) return 'no axe: buy a bronze axe (16 gp) at Bob\'s Axes in Lumbridge (3230, 3203)';

// Walks the waypoints. Returns false if something attacked the player on the way.
async function walkRoute(points: { x: number; z: number }[]): Promise<boolean> {
  for (const pt of points) {
    await bot.walkTo(pt.x, pt.z);
    if (fighting()) return false;
  }
  return true;
}

while (Date.now() < deadline && trips < MAX_TRIPS) {
  if (sdk.getInventory().length < 28) {
    const p = sdk.getState()?.player;
    if (p && Math.hypot(p.worldX - TREES.x, p.worldZ - TREES.z) > 15) await bot.walkTo(TREES.x, TREES.z);
    const r = await bot.chopTree(/^tree$/i);
    if (r.success) { chopped++; fails = 0; } else if (++fails >= 5) { console.log(`chop failed: ${r.message}`); break; }
    continue;
  }
  const before = logsHeld();
  if (!(await walkRoute(ROUTE_TO_BANK))) {
    await bot.walkTo(TREES.x, TREES.z);
    return `attacked on the way to the bank, went back to the Lumbridge trees; chopped ${chopped}, banked ${banked}, ${logsHeld()} logs held`;
  }
  const open = await bot.openBank();
  if (!open.success) { console.log(`bank: ${open.message}`); break; }
  await bot.depositItem(/logs$/i, -1);
  banked += before - logsHeld();
  await bot.closeBank();
  trips++;
  if (sdk.getInventory().length >= 28) return `inventory is full of other items: run bank-deposit-all; chopped ${chopped}, banked ${banked}`;
  if (!(await walkRoute(ROUTE_TO_TREES))) return `attacked on the way back to the trees; chopped ${chopped}, banked ${banked}`;
}
return `chopped ${chopped} logs, banked ${banked} in ${trips} trips, ${logsHeld()} logs held`;
