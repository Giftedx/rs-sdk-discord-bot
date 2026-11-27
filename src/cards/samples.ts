import type { CardDataMap, CardKind } from './templates';

// Sample data for tests and for previews of each card.
const SKILLS = ['Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Runecraft'];

export const SAMPLE_CARDS: { [K in CardKind]: CardDataMap[K] } = {
  level_up: { skill: 'Woodcutting', level: 31, xp: 14_833 },
  death: {
    place: 'Lumbridge swamp, south of the church',
    time: '2026-11-27 14:05 UTC',
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
};
