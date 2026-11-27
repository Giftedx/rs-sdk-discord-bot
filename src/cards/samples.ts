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
    instruction: 'Chop oak logs near Draynor until the inventory is full, then bank them.',
    summary: 'Walked to the oak trees west of Draynor bank. Chopped 27 oak logs in four trips, banked each load, and stopped at the bank with an empty inventory. No combat on the way.',
    turns: 14,
    costUsd: 0.37,
    durationMs: 4_320_000,
    skills: [{ name: 'Woodcutting', before: 30, after: 31, xp: 4_100 }],
    inventory: [{ name: 'Oak logs', before: 0, after: 27 }, { name: 'Coins', before: 120, after: 120 }],
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
