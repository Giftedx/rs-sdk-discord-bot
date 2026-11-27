// Walk to the nearest known bank and deposit every item except tools (edit KEEP)
const KEEP = /(axe|pickaxe|small fishing net|tinderbox|hammer|knife)$/i;
const MAX_MS = 5 * 60_000;
const MAX_DEPOSITS = 28;
// Al Kharid is behind a toll gate: use it only from inside Al Kharid (x >= 3267, z < 3230).
const BANKS = [
  { name: 'Draynor', x: 3092, z: 3243, ok: (_x: number, _z: number) => true },
  { name: 'Varrock West', x: 3185, z: 3436, ok: (_x: number, _z: number) => true },
  { name: 'Al Kharid', x: 3269, z: 3167, ok: (x: number, z: number) => x >= 3267 && z < 3230 },
];
const deadline = Date.now() + MAX_MS;
const p = sdk.getState()?.player;
if (!p) return 'no player state';
const bank = BANKS.filter(b => b.ok(p.worldX, p.worldZ)).sort((a, b) => Math.hypot(a.x - p.worldX, a.z - p.worldZ) - Math.hypot(b.x - p.worldX, b.z - p.worldZ))[0]!;
const w = await bot.walkTo(bank.x, bank.z);
if (!w.success) console.log(`walk: ${w.message}`);
const open = await bot.openBank();
if (!open.success) return `could not open the ${bank.name} bank: ${open.message}`;
const done: string[] = [];
for (let i = 0; i < MAX_DEPOSITS && Date.now() < deadline; i++) {
  const item = sdk.getInventory().find(it => !KEEP.test(it.name) && !done.includes(it.name));
  if (!item) break;
  const r = await bot.depositItem(item.name, -1);
  done.push(item.name);
  if (!r.success) console.log(`deposit ${item.name}: ${r.message}`);
}
await bot.closeBank();
return `${bank.name} bank: deposited ${done.length} kinds of item; ${sdk.getInventory().length} slots still used`;
