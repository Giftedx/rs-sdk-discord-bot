// Net shrimp at Draynor, then cook them on the fireplace north of the spot; repeats until the limit
const MAX_MS = 13 * 60_000;
const MAX_ROUNDS = 3;
const SPOT = { x: 3087, z: 3230 };   // stay south of z 3232: dark wizards
const FIRE = { x: 3100, z: 3256 };
const deadline = Date.now() + MAX_MS;
const count = (re: RegExp) => sdk.getInventory().filter(i => re.test(i.name)).length;
let caught = 0;
let cooked = 0;
let rounds = 0;

if (!sdk.findInventoryItem(/small fishing net/i)) return 'no small fishing net in the inventory';
if (sdk.getInventory().length >= 28 && count(/^raw /i) === 0) return 'inventory is full: run bank-deposit-all first';
while (Date.now() < deadline && rounds < MAX_ROUNDS) {
  await bot.walkTo(SPOT.x, SPOT.z);
  let idle = 0;
  while (Date.now() < deadline && sdk.getInventory().length < 28 && idle < 5) {
    const spot = sdk.getState()?.nearbyNpcs
      .filter(n => /fishing\s*spot/i.test(n.name) && n.optionsWithIndex.some(o => /^net$/i.test(o.text)))
      .sort((a, b) => a.distance - b.distance)[0];
    if (!spot) { idle++; await sdk.waitForTicks(3); continue; }
    const before = count(/^raw /i);
    const r = await bot.interactNpc(spot, /^net$/i);
    if (!r.success) { idle++; continue; }
    await sdk.waitForCondition(s => s.inventory.filter(i => /^raw /i.test(i.name)).length > before || s.dialog.isOpen, 20_000).catch(() => null);
    await bot.dismissBlockingUI();
    const got = count(/^raw /i) - before;
    if (got > 0) { caught += got; idle = 0; } else idle++;
  }
  if (count(/^raw /i) === 0) break;

  await bot.walkTo(FIRE.x, FIRE.z);
  let tries = 0;
  while (Date.now() < deadline && count(/^raw /i) > 0 && tries++ < 40) {
    const source = sdk.findNearbyLoc(/^(range|fireplace|fire|cooking pot)$/i);
    const raw = sdk.findInventoryItem(/^raw /i);
    if (!source || !raw) break;
    const before = count(/^raw /i);
    const r = await bot.useItemOnLoc(raw, source);
    if (!r.success) { console.log(`cook: ${r.message}`); break; }
    await sdk.waitForCondition(s => s.inventory.filter(i => /^raw /i.test(i.name)).length < before || s.dialog.isOpen, 10_000).catch(() => null);
    await bot.dismissBlockingUI();
    cooked += Math.max(0, before - count(/^raw /i));
  }
  if (count(/^burnt /i) > 0) await bot.dropItem(/^burnt /i);
  rounds++;
}
return `caught ${caught}, cooked ${cooked} (burnt ones dropped), ${count(/^shrimps$/i)} shrimps held after ${rounds} rounds`;
