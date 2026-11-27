// Chop trees at Lumbridge and bank the logs at Draynor, until the time or trip limit
const MAX_MS = 13 * 60_000;
const MAX_TRIPS = 5;
const TREES = { x: 3195, z: 3220 };
const BANK = { x: 3092, z: 3243 };
const deadline = Date.now() + MAX_MS;
const logsHeld = () => sdk.getInventory().filter(i => /logs$/i.test(i.name)).length;
let chopped = 0;
let banked = 0;
let trips = 0;
let fails = 0;

while (Date.now() < deadline && trips < MAX_TRIPS) {
  if (sdk.getInventory().length < 28) {
    const p = sdk.getState()?.player;
    if (p && Math.hypot(p.worldX - TREES.x, p.worldZ - TREES.z) > 15) await bot.walkTo(TREES.x, TREES.z);
    const r = await bot.chopTree(/^tree$/i);
    if (r.success) { chopped++; fails = 0; } else if (++fails >= 5) { console.log(`chop failed: ${r.message}`); break; }
    continue;
  }
  const before = logsHeld();
  await bot.walkTo(BANK.x, BANK.z);
  const open = await bot.openBank();
  if (!open.success) { console.log(`bank: ${open.message}`); break; }
  await bot.depositItem(/logs$/i, -1);
  banked += before - logsHeld();
  await bot.closeBank();
  trips++;
  if (sdk.getInventory().length >= 28) return `inventory is full of other items: run bank-deposit-all; chopped ${chopped}, banked ${banked}`;
}
return `chopped ${chopped} logs, banked ${banked} in ${trips} trips, ${logsHeld()} logs held`;
