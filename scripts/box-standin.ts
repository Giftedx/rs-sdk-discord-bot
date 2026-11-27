// Box stand-in: load the rs-sdk SDK the way a bot script does, connect, and wait.
// It stands in for the sandboxed box process until the real box exists (see docs/roadmap.md).
// Environment: GATEWAY_URL, BOT_USERNAME, PASSWORD (the boot token, never the game password).
// stdout, times in ms from the start of the process (from /proc, so Bun start-up counts):
//   "imported <ms>"                                   SDK modules loaded, collision JSON parsed
//   "pathfinding <ms> ms, land at Lumbridge <bool>"   initPathfinding() time and a check of its result
//   "ready <ms>"                                      first game state received
import { readFileSync } from 'node:fs';
import { BotSDK } from '../vendor/rs-sdk/sdk';
import { BotActions } from '../vendor/rs-sdk/sdk/actions';
import { initPathfinding, isZoneLikelyLand } from '../vendor/rs-sdk/sdk/pathfinding';
import { clockTicksPerSecond } from '../src/measure/proc';

if (process.platform !== 'linux') {
  console.error(`box-standin runs on Linux only (this is ${process.platform})`);
  process.exit(2);
}

// Field 22 of /proc/self/stat is the start time in clock ticks after boot.
const hz = clockTicksPerSecond();
const stat = readFileSync('/proc/self/stat', 'utf8');
const startTicks = Number(stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[22 - 3]);
const processAgeMs = () => {
  const uptimeS = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
  return Math.round((uptimeS - startTicks / hz) * 1000);
};
console.log(`imported ${processAgeMs()}`);

const gatewayUrl = process.env.GATEWAY_URL;
const username = process.env.BOT_USERNAME;
const password = process.env.PASSWORD;
if (!gatewayUrl || !username || !password) {
  console.error('box-standin: GATEWAY_URL, BOT_USERNAME and PASSWORD must be set');
  process.exit(2);
}

// The import of sdk/pathfinding parses the 27.5 MB collision-data.json. runScript
// then calls initPathfinding() before it connects; do the same. A zone counts as
// land only after initPathfinding() has read the collision tiles.
const pfStart = performance.now();
initPathfinding();
const pfMs = Math.round(performance.now() - pfStart);
console.log(`pathfinding ${pfMs} ms, land at Lumbridge ${isZoneLikelyLand(0, 3222, 3218)}`);

const sdk = new BotSDK({
  botUsername: username,
  password,
  gatewayUrl,
  connectionMode: 'control',
  autoReconnect: true,
  autoLaunchBrowser: false,
  showChat: process.env.SHOW_CHAT?.toLowerCase() !== 'false',
});
// Hold a BotActions as a bot script does. The stand-in sends no action.
const bot = new BotActions(sdk);
void bot;

let ready = false;
sdk.onStateUpdate(() => {
  if (ready) return;
  ready = true;
  console.log(`ready ${processAgeMs()}`);
});

await sdk.connect();

const stop = async () => {
  await sdk.disconnect().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
// Wait until a signal arrives.
setInterval(() => {}, 60_000);
