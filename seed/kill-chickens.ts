// Kill chickens at the Lumbridge coop and pick up feathers, until the kill or time limit
const MAX_MS = 10 * 60_000;
const MAX_KILLS = 20;
const COOP = { x: 3237, z: 3295 };
const deadline = Date.now() + MAX_MS;
const feathers = () => sdk.countInventoryItems(/^feather$/i);
const startFeathers = feathers();
let kills = 0;
let misses = 0;

const w = await bot.walkTo(COOP.x, COOP.z);
if (!w.success) {
  const gate = sdk.findNearbyLoc(/^gate$/i);
  if (gate?.optionsWithIndex.some(o => /^open$/i.test(o.text))) await bot.openDoor(gate);
  await bot.walkTo(COOP.x, COOP.z);
}
while (Date.now() < deadline && kills < MAX_KILLS && misses < 6) {
  const chicken = sdk.getState()?.nearbyNpcs
    .filter(n => /^chicken$/i.test(n.name) && !n.inCombat && n.optionsWithIndex.some(o => /attack/i.test(o.text)))
    .sort((a, b) => a.distance - b.distance)[0];
  if (!chicken) { misses++; await sdk.waitForTicks(4); continue; }
  const r = await bot.attack(chicken);
  if (!r.success) { misses++; console.log(`attack: ${r.message}`); continue; }
  const gone = await sdk.waitForCondition(s => !s.nearbyNpcs.some(n => n.index === chicken.index && n.healthPercent !== 0), 30_000)
    .then(() => true, () => false);
  if (!gone) { misses++; continue; }
  kills++;
  misses = 0;
  await sdk.waitForTicks(2);
  const loot = (await sdk.scanGroundItems()).filter(g => /^feather$/i.test(g.name) && g.distance <= 6).slice(0, 3);
  for (const g of loot) await bot.pickupItem(g);
}
const full = sdk.getInventory().length >= 28 && startFeathers === 0 ? ' (inventory full: no room for feathers)' : '';
return `killed ${kills} chickens, picked up ${feathers() - startFeathers} feathers${full}`;
