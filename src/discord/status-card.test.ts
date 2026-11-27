import { describe, expect, test } from 'bun:test';
import { FakeTimers } from './fake-timers';
import { CARD_MARKER, STATUS_ID, StatusCard, currentSkill, renderCard, watchLiveUrl, type CardChannel, type CardMessage, type CardView } from './status-card';

class FakeChannel implements CardChannel {
  pinned: { id: string; content: string }[] = [];
  sent: CardMessage[] = [];
  edits: { id: string; msg: CardMessage }[] = [];
  pins: string[] = [];
  pinFails = false;
  editFails = false;
  async fetchPinned() {
    return this.pinned;
  }
  async send(msg: CardMessage) {
    this.sent.push(msg);
    return `m${this.sent.length}`;
  }
  async edit(id: string, msg: CardMessage) {
    if (this.editFails) throw new Error('Unknown Message');
    this.edits.push({ id, msg });
  }
  async pin(id: string) {
    if (this.pinFails) throw new Error('Missing Permissions');
    this.pins.push(id);
  }
}

const view: CardView = {
  goal: 'reach 10 attack',
  step: 'fighting chickens',
  hp: { hp: 8, maxHp: 10 },
  queueLength: 2,
  spend: { usedUsd: 1.5, capUsd: 20 },
  running: true,
  frame: new Uint8Array([1, 2]),
};

function setup(secrets: string[] = []) {
  const ch = new FakeChannel();
  const timers = new FakeTimers();
  const logs: string[] = [];
  let v = view;
  const card = new StatusCard({ channel: ch, view: () => v, secrets, timers, log: (l) => logs.push(l) });
  return { ch, timers, logs, card, setView: (n: CardView) => (v = n) };
}

describe('StatusCard', () => {
  test('sends and pins a new card with content and buttons', async () => {
    const { ch, card } = setup();
    await card.init();
    expect(ch.sent).toHaveLength(1);
    expect(ch.pins).toEqual(['m1']);
    const m = ch.sent[0]!;
    expect(m.content).toContain(CARD_MARKER);
    expect(m.content).toContain('Goal: reach 10 attack');
    expect(m.content).toContain('Step: fighting chickens');
    expect(m.content).toContain('HP: 8/10');
    expect(m.content).toContain('Queue: 2');
    expect(m.content).toContain('$1.50 of $20.00');
    expect(m.frame).toEqual(new Uint8Array([1, 2]));
    expect(m.buttons.map((b) => b.id)).toEqual([STATUS_ID]);
  });

  test('reuses the old pinned card after a restart', async () => {
    const { ch, card } = setup();
    ch.pinned = [
      { id: 'other', content: 'hello' },
      { id: 'old', content: `**Status** ${CARD_MARKER}` },
    ];
    await card.init();
    expect(ch.sent).toHaveLength(0);
    expect(ch.edits.map((e) => e.id)).toEqual(['old']);
  });

  test('edits every 15 s only while an instruction runs, then one final edit', async () => {
    const { ch, card, timers } = setup();
    await card.init();
    await timers.advance(60_000);
    expect(ch.edits).toHaveLength(0);
    await card.instructionStarted();
    expect(ch.edits).toHaveLength(1);
    await timers.advance(45_000);
    expect(ch.edits).toHaveLength(4);
    await card.instructionEnded();
    expect(ch.edits).toHaveLength(5);
    expect(card.ticking).toBe(false);
    await timers.advance(60_000);
    expect(ch.edits).toHaveLength(5);
  });

  test('a failed pin is logged once', async () => {
    const { ch, card, logs } = setup();
    ch.pinFails = true;
    ch.editFails = true;
    await card.init();
    await card.update();
    expect(ch.sent).toHaveLength(2);
    expect(logs.filter((l) => l.includes('pin failed'))).toHaveLength(1);
  });

  test('secrets are removed from the content', async () => {
    const { ch, card, setView } = setup(['hunter22']);
    setView({ ...view, goal: 'say hunter22 @everyone' });
    await card.init();
    expect(ch.sent[0]!.content).not.toContain('hunter22');
    expect(ch.sent[0]!.content).not.toContain('@everyone');
  });

  test('overlapping updates do not run in parallel', async () => {
    const { ch, card } = setup();
    await card.init();
    await Promise.all([card.update(), card.update(), card.update()]);
    expect(ch.edits.length).toBeLessThanOrEqual(2);
  });
});

describe('status card content', () => {
  const MIN = 60_000;
  const sample = (time: number, xp: number, atk = 100) => ({ time, skills: { Woodcutting: { level: 36, xp }, Attack: { level: 10, xp: atk } } });

  test('current skill and XP per hour from the last 15 minutes', () => {
    // The sample 20 minutes old is outside the window.
    const s = [sample(0, 0, 0), sample(5 * MIN, 1000), sample(10 * MIN, 1300), sample(20 * MIN, 2000)];
    expect(currentSkill(s)).toEqual({ name: 'Woodcutting', level: 36, xpPerHour: 4000 });
    expect(currentSkill([sample(0, 0), sample(30_000, 500)])).toBeNull();
    expect(currentSkill([sample(0, 10), sample(10 * MIN, 10)])).toBeNull();
  });

  test('inventory, skill rate, last event and script name', () => {
    const msg = renderCard({
      ...view, inventory: { used: 19, max: 28 }, script: 'chop-willows', lastEvent: 'I reached 36 Woodcutting.',
      xpSamples: [sample(0, 0), sample(15 * MIN, 535)],
    }, []);
    expect(msg.content).toContain('Step: fighting chickens (script chop-willows)');
    expect(msg.content).toContain('HP: 8/10   Inv: 19/28   Woodcutting 36 (+2,140 xp/h)');
    expect(msg.content).toContain('Last: I reached 36 Woodcutting.');
    expect(msg.buttons).toEqual([{ id: STATUS_ID, label: 'Status' }]);
  });

  test('Watch live link only for an https link', () => {
    const url = watchLiveUrl('https://example.org/world/?follow={account}', 'a b');
    expect(url).toBe('https://example.org/world/?follow=a%20b');
    expect(watchLiveUrl('', 'x')).toBeUndefined();
    expect(watchLiveUrl('http://example.org/?f={account}', 'x')).toBeUndefined();
    expect(watchLiveUrl('not a url', 'x')).toBeUndefined();
    const msg = renderCard(view, [], url);
    expect(msg.buttons.map((b) => b.label)).toEqual(['Status', 'Watch live']);
    expect(msg.buttons[1]!.url).toBe(url);
  });

  test('secrets are removed from the script name and the last event', () => {
    const msg = renderCard({ ...view, script: 'hunter22', lastEvent: 'said hunter22' }, ['hunter22']);
    expect(msg.content).not.toContain('hunter22');
  });
});
