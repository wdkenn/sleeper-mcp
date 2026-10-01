/**
 * Projection normalization and league scoring. No imports: tests run these with `node --test`.
 *
 * Sleeper projections are raw stat lines (pass_yd, rec, ...), not fantasy points.
 * Points come from multiplying each stat by the league's scoring_settings value for that key.
 * Checked against week 3 2026 actuals: this reproduces Sleeper's players_points exactly.
 */

export type StatLine = Record<string, number>;

export type ProjectionEntry = {
  stats: StatLine;
  opponent: string | null;
};

/** Keys that describe ranking or generic scoring, not a projected stat. */
export function isMetaKey(key: string): boolean {
  return /^(pos_)?(adp|rank)_/.test(key) || /^pts_(std|ppr|half_ppr)$/.test(key) || key === "gp";
}

/** True when a stat line has at least one actual projected stat (not just ADP/rank/generic points). */
export function hasProjectedStats(stats: unknown): stats is StatLine {
  if (!stats || typeof stats !== "object") return false;
  return Object.entries(stats).some(([k, v]) => typeof v === "number" && !isMetaKey(k));
}

/**
 * Accepts either response shape:
 *  - api.sleeper.com: array of { player_id, stats, opponent, ... }
 *  - api.sleeper.app/v1: map of player_id -> stats (or -> { stats })
 * Drops entries with no projected stats. An empty result means the source failed.
 */
export function normalizeProjections(raw: unknown): Record<string, ProjectionEntry> {
  const out: Record<string, ProjectionEntry> = {};
  const add = (id: unknown, stats: unknown, opponent: unknown) => {
    if (typeof id !== "string" && typeof id !== "number") return;
    if (!hasProjectedStats(stats)) return;
    out[String(id)] = { stats, opponent: typeof opponent === "string" ? opponent : null };
  };
  if (Array.isArray(raw)) {
    for (const e of raw) {
      if (e && typeof e === "object") add(e.player_id, e.stats, e.opponent);
    }
  } else if (raw && typeof raw === "object") {
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      const nested = v && typeof v === "object" && "stats" in v;
      add(id, nested ? (v as { stats: unknown }).stats : v, nested ? (v as { opponent?: unknown }).opponent : null);
    }
  }
  return out;
}

export type ScoredLine = {
  points: number;
  /** Stat keys present in the projection with no league scoring rule (meta keys excluded). */
  unscored: string[];
  /** ADP / rank / generic points keys present but not scored. */
  meta: string[];
  /** Stat keys computed from others because the projection omits them. */
  derived: string[];
};

/**
 * Projections give missed FGs only by distance (fgmiss_30_39, ...); actual stats also carry the
 * total `fgmiss`, which is what most leagues score. Fill it in when absent.
 */
function withDerived(stats: StatLine): { stats: StatLine; derived: string[] } {
  if ("fgmiss" in stats) return { stats, derived: [] };
  const buckets = Object.entries(stats).filter(([k]) => /^fgmiss_\d/.test(k));
  if (!buckets.length) return { stats, derived: [] };
  return {
    stats: { ...stats, fgmiss: buckets.reduce((sum, [, v]) => sum + v, 0) },
    derived: ["fgmiss"],
  };
}

export function scoreStats(raw: StatLine, scoring: Record<string, number>): ScoredLine {
  const { stats, derived } = withDerived(raw);
  let points = 0;
  const unscored: string[] = [];
  const meta: string[] = [];
  for (const [k, v] of Object.entries(stats)) {
    if (typeof v !== "number") continue;
    if (k in scoring) points += v * scoring[k];
    else if (isMetaKey(k)) meta.push(k);
    else unscored.push(k);
  }
  return { points: Math.round(points * 100) / 100, unscored, meta, derived };
}

export type ScoredSet = {
  points: Map<string, number>;
  /** Stat key -> number of players whose projection had it with no league scoring rule. */
  unscored_stat_keys: Record<string, number>;
  /** ADP / rank / generic-format points keys seen and not scored. */
  ignored_meta_keys: string[];
  derived_stat_keys: string[];
};

/** Score a set of players. Ids with no projection are left out of `points`. */
export function scoreProjections(
  players: Record<string, ProjectionEntry>,
  ids: Iterable<string>,
  scoring: Record<string, number>,
): ScoredSet {
  const points = new Map<string, number>();
  const unscored: Record<string, number> = {};
  const meta = new Set<string>();
  const derived = new Set<string>();
  for (const id of ids) {
    const entry = players[id];
    if (!entry || points.has(id)) continue;
    const line = scoreStats(entry.stats, scoring);
    points.set(id, line.points);
    for (const k of line.unscored) unscored[k] = (unscored[k] || 0) + 1;
    line.meta.forEach((k) => meta.add(k));
    line.derived.forEach((k) => derived.add(k));
  }
  return {
    points,
    unscored_stat_keys: Object.fromEntries(Object.entries(unscored).sort(([a], [b]) => a.localeCompare(b))),
    ignored_meta_keys: [...meta].sort(),
    derived_stat_keys: [...derived].sort(),
  };
}
