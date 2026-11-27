// Skip the tutorial (up to 3 tries) and report where the player ends up
const MAX_MS = 3 * 60_000;
const MAX_TRIES = 3;
const deadline = Date.now() + MAX_MS;
let last = 'not tried';
for (let i = 1; i <= MAX_TRIES && Date.now() < deadline; i++) {
  const r = await bot.skipTutorial();
  last = `try ${i}: ${r.success ? 'ok' : 'failed'} ${r.message ?? ''}`.trim();
  console.log(last);
  if (r.success) break;
  await sdk.waitForTicks(5);
}
const p = sdk.getState()?.player;
return `${last}; at (${p?.worldX}, ${p?.worldZ})`;
