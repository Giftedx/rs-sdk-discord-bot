// Mine copper and tin at the SE Varrock mine and bank the ore at Varrock West, until the limit
const MAX_MS = 13 * 60_000;
const MAX_TRIPS = 4;
const MINE = { x: 3285, z: 3365 };
const TO_BANK = [{ x: 3270, z: 3380 }, { x: 3250, z: 3395 }, { x: 3230, z: 3410 }, { x: 3210, z: 3425 }, { x: 3185, z: 3436 }];
const deadline = Date.now() + MAX_MS;
const oreHeld = () => sdk.getInventory().filter(i => /^(copper|tin) ore$/i.test(i.name)).length;
let mined = 0;
let banked = 0;
let trips = 0;
let fails = 0;
let nextTin = false;

if (!sdk.findInventoryItem(/pickaxe/i) && !sdk.findEquipmentItem(/pickaxe/i)) return 'no pickaxe';
while (Date.now() < deadline && trips < MAX_TRIPS) {
  if (sdk.getInventory().length < 28) {
    const p = sdk.getState()?.player;
    if (p && Math.hypot(p.worldX - MINE.x, p.worldZ - MINE.z) > 12) {
      const w = await bot.walkTo(MINE.x, MINE.z);
      if (!w.success) { console.log(`walk to mine: ${w.message}`); if (++fails >= 3) break; continue; }
    }
    const want = nextTin ? /tin ore/i : /copper ore/i;
    const rock = sdk.findNearbyLoc(want) ?? sdk.findNearbyLoc(/(copper|tin) ore/i);
    if (!rock) { if (++fails >= 5) { console.log('no copper or tin rock near'); break; } await sdk.waitForTicks(5); continue; }
    const before = oreHeld();
    const r = await bot.mineRock(rock);
    let ok = r.success;
    // On the local stack mineRock can report "rejected" while the swing goes on; wait for the ore.
    if (!ok && r.reason === 'rejected') {
      ok = await sdk.waitForCondition(s => s.inventory.filter(i => /^(copper|tin) ore$/i.test(i.name)).length > before, 20_000)
        .then(() => true, () => false);
    }
    if (ok) { mined++; fails = 0; nextTin = !nextTin; } else if (++fails >= 5) { console.log(`mine failed: ${r.message}`); break; }
    continue;
  }
  const before = oreHeld();
  for (const wp of TO_BANK) await bot.walkTo(wp.x, wp.z);
  const open = await bot.openBank();
  if (!open.success) { console.log(`bank: ${open.message}`); break; }
  await bot.depositItem(/^(copper ore|tin ore)$/i, -1);
  banked += before - oreHeld();
  await bot.closeBank();
  trips++;
  if (sdk.getInventory().length >= 28) return `inventory is full of other items: run bank-deposit-all; mined ${mined}, banked ${banked}`;
  for (const wp of [...TO_BANK].reverse().slice(1)) await bot.walkTo(wp.x, wp.z);
}
return `mined ${mined} ore, banked ${banked} in ${trips} trips, ${oreHeld()} ore held`;
