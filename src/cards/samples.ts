import type { CardDataMap, CardKind } from './templates';

// Sample data for tests and for previews of each card.
const SKILLS = ['Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];

export const SAMPLE_CARDS: { [K in CardKind]: CardDataMap[K] } = {
  level_up: { skill: 'Woodcutting', level: 31, xp: 14_833, from: 30, totalLevel: 214 },
  death: {
    place: 'Lumbridge swamp, south of the church',
    time: '2026-11-27 14:05 UTC',
    killer: 'Giant rat',
    items: [
      { id: 1351, name: 'Bronze axe', count: 1 },
      { id: 995, name: 'Coins', count: 1_250 },
      { id: 590, name: 'Tinderbox', count: 1 },
    ],
  },
  instruction_receipt: {
    by: 'Robin',
    instruction: 'Chop oak logs near Draynor until the inventory is full, then bank them.',
    summary: 'Walked to the oak trees west of Draynor bank. Chopped 27 oak logs in four trips, banked each load, and stopped at the bank with an empty inventory. No combat on the way.',
    turns: 14,
    costUsd: 0.37,
    durationMs: 4_320_000,
    skills: [{ name: 'Woodcutting', before: 30, after: 31, xp: 4_100 }],
    inventory: [{ id: 1521, name: 'Oak logs', before: 0, after: 27 }, { id: 995, name: 'Coins', before: 120, after: 95 }, { id: 590, name: 'Tinderbox', before: 1, after: 0 }],
  },
  daily_recap: {
    date: '2026-11-27',
    counts: [
      { label: 'instructions', value: 6 },
      { label: 'level ups', value: 3 },
      { label: 'deaths', value: 1 },
      { label: 'xp gained', value: 48_210 },
      { label: 'wakes', value: 41 },
      { label: 'turns', value: 212 },
    ],
    xp: [{ skill: 'Woodcutting', xp: 41_200 }, { skill: 'Firemaking', xp: 7_010 }],
  },
  status: {
    hp: 7,
    maxHp: 31,
    goal: 'Reach level 40 Woodcutting at the willows south of Draynor.',
    skills: SKILLS.map((name, i) => ({ name, level: 1 + ((i * 7) % 45), xp: i * 1000 })),
    items: [
      { id: 1351, name: 'Bronze axe', count: 1 },
      { id: 995, name: 'Coins', count: 125_000 },
      { id: 1519, name: 'Willow logs', count: 1 },
      { id: 1519, name: 'Willow logs', count: 1 },
      { id: 590, name: 'Tinderbox', count: 1 },
    ],
  },
  equipment: {
    combatLevel: 21,
    style: 'Accurate (Chop)',
    worn: [
      { slot: 'head', id: 1139, name: 'Bronze med helm', count: 1 },
      { slot: 'weapon', id: 1353, name: 'Steel axe', count: 1 },
      { slot: 'body', id: 1117, name: 'Bronze platebody', count: 1 },
      { slot: 'shield', id: 1171, name: 'Wooden shield', count: 1 },
      { slot: 'legs', id: 1075, name: 'Bronze platelegs', count: 1 },
      { slot: 'ammo', id: 882, name: 'Bronze arrow', count: 150 },
    ],
  },
  inventory: {
    items: [
      { slot: 0, id: 1351, name: 'Bronze axe', count: 1 },
      { slot: 1, id: 590, name: 'Tinderbox', count: 1 },
      { slot: 2, id: 995, name: 'Coins', count: 1_250 },
      { slot: 4, id: 1521, name: 'Oak logs', count: 1 },
      { slot: 5, id: 1521, name: 'Oak logs', count: 1 },
      { slot: 27, id: 315, name: 'Shrimps', count: 1 },
    ],
  },
  bank: {
    seen: '2 hours ago',
    total: 94,
    items: Array.from({ length: 80 }, (_, i) => ({ id: 1500 + i, name: `Item ${i + 1}`, count: (i * 37) % 500 + 1 })),
  },
  skills: {
    combatLevel: 21,
    skills: SKILLS.map((name, i) => {
      const base = 1 + ((i * 7) % 45);
      return { name, base, level: i === 3 ? base - 4 : i === 1 ? base + 3 : base };
    }),
  },
  ge: {
    seen: '10 minutes ago',
    offers: [
      { id: 1521, name: 'Oak logs', side: 'sell', quantity: 200, price: 22, filled: 140, state: 'open' },
      { id: 1353, name: 'Steel axe', side: 'buy', quantity: 1, price: 210, filled: 1, state: 'completed' },
      { id: 317, name: 'Raw shrimps', side: 'buy', quantity: 500, price: 6, filled: 120, state: 'cancelled' },
    ],
  },
  xp_chart: {
    title: 'Last 24 hours, UTC',
    labels: Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')),
    series: [
      { name: 'Total', values: Array.from({ length: 24 }, (_, i) => (i % 6 === 0 ? 0 : 2_000 + ((i * 937) % 3_000))) },
      { name: 'Woodcutting', values: Array.from({ length: 24 }, (_, i) => (i % 6 === 0 ? 0 : 1_500 + ((i * 611) % 1_500))) },
      { name: 'Firemaking', values: Array.from({ length: 24 }, (_, i) => (i % 4 === 0 ? 300 : 0)) },
    ],
  },
};
