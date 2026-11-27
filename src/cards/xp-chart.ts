// Builds the data of the XP chart card from stored skill samples: XP gained in each hour of a period,
// for the total and for the skills with the most XP gained.
import type { SkillSample } from '../discord/status-card';
import type { XpChartCard } from './templates';

const HOUR = 3_600_000;

function xpAt(sorted: SkillSample[], t: number, skill: string | null): number {
  let s = sorted[0]!;
  for (const x of sorted) {
    if (x.time > t) break;
    s = x;
  }
  if (skill !== null) return s.skills[skill]?.xp ?? 0;
  return Object.values(s.skills).reduce((n, k) => n + k.xp, 0);
}

/**
 * XP gained per hour over the `hours` before `now`: the total and the top `top` skills.
 * Before the first sample the gain is 0. Returns null with fewer than 2 samples or no XP gained.
 */
export function xpChartData(samples: SkillSample[], now: number, hours = 24, top = 3): XpChartCard | null {
  if (samples.length < 2 || hours < 2) return null;
  const sorted = [...samples].sort((a, b) => a.time - b.time);
  const start = now - hours * HOUR;
  const edges = Array.from({ length: hours + 1 }, (_, i) => start + i * HOUR);
  const gains = (skill: string | null) => edges.slice(1).map((e, i) => Math.max(0, xpAt(sorted, e, skill) - xpAt(sorted, edges[i]!, skill)));
  const total = gains(null);
  if (total.every((v) => v === 0)) return null;
  const names = new Set(sorted.flatMap((s) => Object.keys(s.skills)));
  const skills = [...names]
    .map((name) => ({ name, values: gains(name) }))
    .map((s) => ({ ...s, sum: s.values.reduce((a, b) => a + b, 0) }))
    .filter((s) => s.sum > 0)
    .sort((a, b) => b.sum - a.sum || a.name.localeCompare(b.name))
    .slice(0, top);
  const labels = edges.slice(1).map((e) => String(new Date(e).getUTCHours()).padStart(2, '0'));
  return {
    title: `Last ${hours} hours, UTC`,
    labels,
    series: [{ name: 'Total', values: total }, ...skills.map(({ name, values }) => ({ name, values }))],
  };
}
