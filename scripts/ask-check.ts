// Runs channel lines through the real message sorter and the real quick-answer prompt, with the
// real knowledge pack and the real small model, and prints each sort and answer. It sends
// nothing to Discord and runs no game action. It costs a few small-model calls.
//
//   bun --no-env-file scripts/ask-check.ts [lines.json]
//
// Needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment; SMALL_MODEL is optional.
// lines.json: [{ "author": "...", "text": "..." }, ...]. Without it, the script uses the built-in
// lines. The game state is the fixed text below, not the live account.
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKnowledgePack, searchKnowledge } from '../src/agent/store';
import { addresseePrompt, parseAddressee, type ChannelLine } from '../src/bot/addressee';
import { questionPrompt } from '../src/bot/answer';

const ROOT = join(import.meta.dir, '..');
const model = process.env.SMALL_MODEL || 'claude-haiku-5-5';
const BOT = 'rs-bot';

const STATE = [
  'Player: combat 39, HP 35/35, at (3222, 3218) Lumbridge',
  'Skills: Attack 36, Strength 35, Defence 1, Hitpoints 35, Ranged 1, Prayer 1, Magic 1, Woodcutting 69, Firemaking 1, Mining 1, Fishing 1, Cooking 1',
  'Equipment: right hand Steel axe',
  'Inventory: Bronze axe, Logs x5',
].join('\n');
const STATUS = ['**Now:** nothing', '**Queue:** empty', '**Timers:** none', '**Spend:** $3.40 of $150.00 this period', '```', STATE, '```'].join('\n');

const DEFAULT_LINES = [
  { author: 'thepanj', text: 'Also OSRS has sword and long swords now' },
  { author: 'hagggis', text: 'lemme finish this last change and update it with the wiki fixes' },
  { author: 'hagggis', text: 'check which axe you can use' },
  { author: 'hagggis', text: 'whats the best axe you can use at your current level' },
  { author: 'hagggis', text: 'do you have access to the wiki knowledge?' },
  { author: 'hagggis', text: 'what can you tell me about woodcutting axes' },
  { author: 'hagggis', text: 'what defence level do you need for rune armour?' },
  { author: 'hagggis', text: 'whats the best melee weapon for stab' },
  { author: 'thepanj', text: 'no shared on that weapon, noob x' },
];

const lines: { author: string; text: string }[] = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : DEFAULT_LINES;
const client = new Anthropic();
const knowledge = createKnowledgePack(ROOT);
await knowledge.bodyReady;

async function small(prompt: string): Promise<string> {
  const r = await client.messages.create({ model, max_tokens: 2_000, output_config: { effort: 'low' }, messages: [{ role: 'user', content: prompt }] } as never);
  return (r as { content: { type: string; text?: string }[] }).content.filter(b => b.type === 'text').map(b => b.text ?? '').join('\n').trim();
}

const history: ChannelLine[] = [];
for (const l of lines) {
  const addr = parseAddressee(await small(addresseePrompt({ botName: BOT, history, author: l.author, text: l.text, direct: false })), false);
  console.log(`\n> ${l.author}: ${l.text}\n  sorted: ${addr.toBot ? addr.kind : 'not for the bot'}`);
  history.push({ author: l.author, isBot: false, text: l.text });
  if (addr.kind !== 'question') continue;
  const found = searchKnowledge(knowledge, l.text.slice(0, 1_000));
  const answer = await small(questionPrompt({ status: STATUS, knowledge: found, history: history.slice(0, -1), author: l.author, text: l.text }));
  console.log(`  answer: ${answer.replace(/\s+/g, ' ')}`);
  history.push({ author: BOT, isBot: true, text: answer });
}
