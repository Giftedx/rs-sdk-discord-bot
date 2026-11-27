// One real call chain to the Anthropic API through the agent loop, with a fake game.
// It checks that the API accepts the request shape of the bot: tools, effort, caching and
// the server-side fallback. It sends no API reference, so it costs a few cents at most.
// Usage: ( set -a; . secrets/bot.env; set +a; bun scripts/ai-check.ts )
import Anthropic from '@anthropic-ai/sdk';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstruction } from '../src/agent/loop';
import { createSpendTracker } from '../src/agent/spend';
import { createStore } from '../src/agent/store';

const model = process.env.AI_MODEL || 'claude-opus-5-5';
const dir = mkdtempSync(join(tmpdir(), 'ai-check-'));
const client = new Anthropic();
const tools: string[] = [];

const result = await runInstruction({
  model,
  effort: 'low',
  callModel: (params, signal) => client.beta.messages.create(
    { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as typeof params, { signal }),
  runJob: async code => { tools.push('run_code'); return { exitCode: 0, output: `fake job ran ${code.length} characters\n── Result ──\nok`, timedOut: false, aborted: false, durationMs: 10 }; },
  store: createStore(dir),
  knowledge: [],
  apiReference: '(not sent in this check)',
  gameState: () => { tools.push('game_state'); return 'Position (3222, 3218) Lumbridge. HP 10/10. Inventory: bronze axe.'; },
  frame: async () => null,
  spend: createSpendTracker(join(dir, 'spend.json'), 1),
  maxTurns: 4,
  maxInstructionUsd: 0.5,
  onProgress: line => console.error(`progress: ${line}`),
}, 'This is a test. Call game_state once, then call finish with the HP that you read.', 'ai-check', new AbortController().signal);

console.log(JSON.stringify({ model, stopReason: result.stopReason, turns: result.turns, usd: Number(result.usd.toFixed(4)), tools, summary: result.summary }));
process.exit(result.stopReason === 'finished' && tools.includes('game_state') ? 0 : 1);
