import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstruction, type AgentDeps } from './loop';
import { createStore } from './store';
import { createSpendTracker } from './spend';

type Block = { type: string; [k: string]: unknown };

function reply(content: Block[], stop = 'tool_use') {
  return { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop,
    usage: { input_tokens: 1000, output_tokens: 100 } } as never;
}

function deps(replies: unknown[], over: Partial<AgentDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-'));
  const calls: unknown[] = [];
  const jobs: string[] = [];
  const d: AgentDeps = {
    model: 'claude-opus-5-5',
    effort: 'medium',
    callModel: async params => { calls.push(structuredClone(params)); return replies.shift() as never; },
    runJob: async code => { jobs.push(code); return { exitCode: 0, output: 'chopped', timedOut: false, aborted: false, durationMs: 1000 }; },
    store: createStore(dir),
    knowledge: [],
    apiReference: 'API',
    gameState: () => 'HP 10/10',
    frame: async () => new Uint8Array([1, 2, 3]),
    spend: createSpendTracker(join(dir, 'spend.json'), 100),
    maxTurns: 10,
    maxInstructionUsd: 5,
    onProgress: () => {},
    ...over,
  };
  return { d, calls, jobs };
}

describe('runInstruction', () => {
  test('runs code, then finishes with a summary', async () => {
    const { d, calls, jobs } = deps([
      reply([{ type: 'tool_use', id: 't1', name: 'run_code', input: { code: 'await bot.chopTree();' } }]),
      reply([{ type: 'tool_use', id: 't2', name: 'finish', input: { summary: 'Chopped a tree.' } }]),
    ]);
    const r = await runInstruction(d, 'chop a tree', 'alice', new AbortController().signal);
    expect(r.stopReason).toBe('finished');
    expect(r.summary).toBe('Chopped a tree.');
    expect(jobs).toEqual(['await bot.chopTree();']);
    const second = calls[1] as { messages: { role: string; content: unknown }[] };
    const last = second.messages.at(-1)!;
    expect(last.role).toBe('user');
    expect(JSON.stringify(last.content)).toContain('chopped');
    expect(r.usd).toBeGreaterThan(0);
  });

  test('a tool error goes back as is_error and the loop goes on', async () => {
    const { d, calls } = deps([
      reply([{ type: 'tool_use', id: 't1', name: 'read_script', input: { name: 'missing' } }]),
      reply([{ type: 'text', text: 'ok' }], 'end_turn'),
    ]);
    const r = await runInstruction(d, 'x', 'bob', new AbortController().signal);
    expect(r.stopReason).toBe('no_tools');
    expect(JSON.stringify((calls[1] as { messages: unknown[] }).messages.at(-1))).toContain('"is_error":true');
  });

  test('stops at the turn cap', async () => {
    const many = Array.from({ length: 5 }, (_, i) => reply([{ type: 'tool_use', id: `t${i}`, name: 'game_state', input: {} }]));
    const { d } = deps(many, { maxTurns: 3 });
    const r = await runInstruction(d, 'x', 'bob', new AbortController().signal);
    expect(r.stopReason).toBe('turn_cap');
    expect(r.turns).toBe(3);
  });

  test('stops at the per-instruction spend cap', async () => {
    const many = Array.from({ length: 5 }, (_, i) => reply([{ type: 'tool_use', id: `t${i}`, name: 'game_state', input: {} }]));
    const { d } = deps(many, { maxInstructionUsd: 0.000001 });
    const r = await runInstruction(d, 'x', 'bob', new AbortController().signal);
    expect(r.stopReason).toBe('spend_cap');
    expect(r.turns).toBe(1);
  });

  test('an aborted signal stops before the first call', async () => {
    const { d, calls } = deps([]);
    const ac = new AbortController();
    ac.abort();
    const r = await runInstruction(d, 'x', 'bob', ac.signal);
    expect(r.stopReason).toBe('aborted');
    expect(calls.length).toBe(0);
  });

  test('look returns an image and keeps the frame', async () => {
    const { d, calls } = deps([
      reply([{ type: 'tool_use', id: 't1', name: 'look', input: {} }]),
      reply([{ type: 'tool_use', id: 't2', name: 'finish', input: { summary: 's' } }]),
    ]);
    const r = await runInstruction(d, 'x', 'bob', new AbortController().signal);
    expect(r.lastFrame).not.toBeNull();
    expect(JSON.stringify((calls[1] as { messages: unknown[] }).messages.at(-1))).toContain('"type":"image"');
  });
});

describe('optional tools and wake kinds', () => {
  const names = (c: unknown) => (c as { tools: { name: string }[] }).tools.map(t => t.name);

  test('optional tools are offered only when deps support them', async () => {
    const plain = deps([reply([{ type: 'text', text: 'ok' }], 'end_turn')]);
    await runInstruction(plain.d, 'x', 'bob', new AbortController().signal);
    expect(names(plain.calls[0])).not.toContain('set_timer');
    expect(names(plain.calls[0])).not.toContain('escalate');

    const full = deps([reply([{ type: 'text', text: 'ok' }], 'end_turn')], { setTimer: () => {}, post: () => {}, setGoal: () => {}, escalationModel: 'claude-fable-5-2' });
    await runInstruction(full.d, 'x', 'bob', new AbortController().signal);
    expect(names(full.calls[0])).toEqual(expect.arrayContaining(['set_timer', 'post', 'set_goal', 'escalate']));
  });

  test('set_timer, post and set_goal call their callbacks; bad minutes is an error', async () => {
    const timers: [number, string][] = [];
    const posts: string[] = [];
    const goals: string[] = [];
    const { d, calls } = deps([
      reply([
        { type: 'tool_use', id: 't1', name: 'set_timer', input: { minutes: 30, note: 'check the fishing job' } },
        { type: 'tool_use', id: 't2', name: 'set_timer', input: { minutes: 5000, note: 'too far' } },
        { type: 'tool_use', id: 't3', name: 'post', input: { text: 'Level 10 fishing!' } },
        { type: 'tool_use', id: 't4', name: 'set_goal', input: { text: 'Train fishing to 20' } },
      ]),
      reply([{ type: 'tool_use', id: 't5', name: 'finish', input: { summary: 's' } }]),
    ], { setTimer: (m, n) => { timers.push([m, n]); }, post: t => { posts.push(t); }, setGoal: t => { goals.push(t); } });
    const r = await runInstruction(d, 'x', 'bob', new AbortController().signal);
    expect(r.stopReason).toBe('finished');
    expect(timers).toEqual([[30, 'check the fishing job']]);
    expect(posts).toEqual(['Level 10 fishing!']);
    expect(goals).toEqual(['Train fishing to 20']);
    const results = (calls[1] as { messages: { content: { tool_use_id: string; is_error?: boolean }[] }[] }).messages.at(-1)!.content;
    expect(results.find(x => x.tool_use_id === 't2')!.is_error).toBe(true);
    expect(results.find(x => x.tool_use_id === 't1')!.is_error).toBeUndefined();
  });

  test('escalate switches the model once', async () => {
    const { d, calls } = deps([
      reply([{ type: 'tool_use', id: 't1', name: 'escalate', input: { reason: 'stuck' } }]),
      reply([{ type: 'tool_use', id: 't2', name: 'escalate', input: { reason: 'again' } }]),
      reply([{ type: 'tool_use', id: 't3', name: 'finish', input: { summary: 's' } }]),
    ], { escalationModel: 'claude-fable-5-2' });
    const r = await runInstruction(d, 'x', 'bob', new AbortController().signal);
    const models = calls.map(c => (c as { model: string }).model);
    expect(models).toEqual(['claude-opus-5-5', 'claude-fable-5-2', 'claude-fable-5-2']);
    expect(r.escalated).toBe(true);
    expect(r.model).toBe('claude-fable-5-2');
    expect(JSON.stringify((calls[2] as { messages: unknown[] }).messages.at(-1))).toContain('already escalated');
  });

  test('a timer wake says so in the first message', async () => {
    const { d, calls } = deps([reply([{ type: 'text', text: 'ok' }], 'end_turn')]);
    await runInstruction(d, 'check the job', 'timer', new AbortController().signal, 'timer');
    const first = (calls[0] as { messages: { content: string }[] }).messages[0]!.content;
    expect(first).toContain('A timer that you set fired');
    expect(first).toContain('check the job');
  });

  test('a job stopped by the orchestrator shows the reason', async () => {
    const { d, calls } = deps([
      reply([{ type: 'tool_use', id: 't1', name: 'run_code', input: { code: 'x' } }]),
      reply([{ type: 'text', text: 'ok' }], 'end_turn'),
    ], { runJob: async () => ({ exitCode: -1, output: '', timedOut: false, aborted: true, durationMs: 1, stopReason: 'no progress' }) as never });
    await runInstruction(d, 'x', 'bob', new AbortController().signal);
    expect(JSON.stringify((calls[1] as { messages: unknown[] }).messages.at(-1))).toContain('Job stopped by the orchestrator: no progress.');
  });
});
