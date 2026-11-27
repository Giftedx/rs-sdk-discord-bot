// Walk to a named place (edit PLACE; the table lists the names); opens gates and retries
const PLACE = 'lumbridge';
const MAX_MS = 5 * 60_000;
const MAX_TRIES = 4;
const PLACES: Record<string, { x: number; z: number }> = {
  lumbridge: { x: 3222, z: 3218 },
  'lumbridge trees': { x: 3195, z: 3220 },
  'lumbridge cows': { x: 3253, z: 3290 },
  'lumbridge chickens': { x: 3237, z: 3295 },
  'lumbridge goblins': { x: 3252, z: 3230 },
  'lumbridge range': { x: 3230, z: 3196 },
  'lumbridge general store': { x: 3212, z: 3247 },
  'draynor bank': { x: 3092, z: 3243 },
  'draynor fishing': { x: 3087, z: 3230 },
  'varrock west bank': { x: 3185, z: 3436 },
  'varrock se mine': { x: 3285, z: 3365 },
  'varrock oaks': { x: 3190, z: 3458 },
  'barbarian village fishing': { x: 3110, z: 3434 },
  'al kharid toll gate': { x: 3268, z: 3228 },
};
const target = PLACES[PLACE.toLowerCase()];
if (!target) return `unknown place ${PLACE}; known: ${Object.keys(PLACES).join(', ')}`;
const deadline = Date.now() + MAX_MS;
const distance = () => { const p = sdk.getState()?.player; return p ? Math.hypot(p.worldX - target.x, p.worldZ - target.z) : Infinity; };
let last = '';
for (let i = 1; i <= MAX_TRIES && Date.now() < deadline; i++) {
  const r = await bot.walkTo(target.x, target.z, 3, { timeout: Math.min(180_000, Math.max(5_000, deadline - Date.now())) });
  last = r.message ?? '';
  if (r.success || distance() <= 4) return `at ${PLACE} (${target.x}, ${target.z}) after ${i} tries`;
  const gate = sdk.findNearbyLoc(/^(gate|door|large door)$/i);
  if (gate?.optionsWithIndex.some(o => /^open$/i.test(o.text))) await bot.openDoor(gate);
  await sdk.waitForTicks(2);
}
return `not at ${PLACE}: ${Math.round(distance())} tiles away; last walk: ${last}`;
