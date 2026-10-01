/** Head-to-head pairing for /league/{id}/matchups/{week}. No imports: tests run these with `node --test`. */

export type MatchupRow = {
  roster_id: number;
  matchup_id: number | null;
  points: number | null;
  custom_points: number | null;
  starters: string[] | null;
  starters_points: number[] | null;
  players: string[] | null;
  players_points: Record<string, number> | null;
};

export type TeamInfo = { owner_id: string | null; owner_name: string; team_name: string | null };

export type PlayerInfo = { name: string; position: string | null; team: string | null };

export type PlayerLookup = {
  player: (id: string) => PlayerInfo;
  /** League-scored projected points, or null when projections are unavailable for this player. */
  projected?: (id: string) => number | null;
};

const round = (n: number) => Math.round(n * 100) / 100;

/** Commissioner overrides (custom_points) win over computed points, as in the Sleeper app. */
function totals(row: MatchupRow, teams: Map<number, TeamInfo>) {
  const info = teams.get(row.roster_id);
  return {
    roster_id: row.roster_id,
    team_name: info?.team_name || info?.owner_name || `Roster ${row.roster_id}`,
    owner_name: info?.owner_name || "Open",
    points: row.custom_points ?? row.points ?? 0,
    ...(row.custom_points != null ? { points_overridden: true } : {}),
  };
}

/** Group rows into games by matchup_id. Rows with a null matchup_id (byes) come back separately. */
export function pairByMatchup(rows: MatchupRow[]) {
  const games = new Map<number, MatchupRow[]>();
  const unpaired: MatchupRow[] = [];
  for (const row of rows) {
    if (row.matchup_id == null) {
      unpaired.push(row);
      continue;
    }
    const g = games.get(row.matchup_id) || [];
    g.push(row);
    games.set(row.matchup_id, g);
  }
  return {
    games: [...games.entries()].sort(([a], [b]) => a - b),
    unpaired,
  };
}

function outcome(teams: Array<{ team_name: string; points: number }>) {
  if (teams.length !== 2) return {};
  const [a, b] = teams;
  const margin = round(Math.abs(a.points - b.points));
  return { leader: a.points === b.points ? null : a.points > b.points ? a.team_name : b.team_name, margin };
}

export function buildScoreboard(rows: MatchupRow[], teams: Map<number, TeamInfo>) {
  const { games, unpaired } = pairByMatchup(rows);
  return {
    games: games.map(([matchup_id, g]) => {
      const sides = g.map((r) => totals(r, teams));
      return { matchup_id, teams: sides, ...outcome(sides) };
    }),
    no_matchup: unpaired.map((r) => totals(r, teams)),
  };
}

/**
 * starters[] and starters_points[] are positionally aligned with each other and with the
 * starting slots at the front of roster_positions. Zip by index; never sort.
 */
export function buildTeamDetail(
  row: MatchupRow,
  teams: Map<number, TeamInfo>,
  slots: string[],
  lookup: PlayerLookup,
) {
  const starterIds = row.starters || [];
  const startersPoints = row.starters_points || [];
  const playersPoints = row.players_points || {};
  const proj = (id: string) => (lookup.projected ? lookup.projected(id) : null);
  const describe = (id: string, points: number | null) => ({
    id,
    ...lookup.player(id),
    points,
    ...(lookup.projected ? { projected: proj(id) } : {}),
  });

  const starters = starterIds.map((id, i) => {
    const slot = slots[i] || null;
    // Sleeper uses "0" for an empty starting slot.
    if (!id || id === "0") return { slot, id: null, name: "EMPTY", position: null, team: null, points: 0 };
    return { slot, ...describe(id, startersPoints[i] ?? playersPoints[id] ?? null) };
  });

  const starterSet = new Set(starterIds);
  const bench = (row.players || [])
    .filter((id) => !starterSet.has(id))
    .map((id) => describe(id, playersPoints[id] ?? null))
    // Before kickoff every bench player has 0 points; fall back to projections.
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0) || (proj(b.id) ?? -1) - (proj(a.id) ?? -1));

  let projected_total: number | null = null;
  if (lookup.projected) {
    const values = starterIds.filter((id) => id && id !== "0").map(proj);
    projected_total = values.some((v) => v != null) ? round(values.reduce<number>((s, v) => s + (v ?? 0), 0)) : null;
  }

  return {
    ...totals(row, teams),
    ...(lookup.projected ? { projected_total } : {}),
    starters,
    bench,
  };
}

export function buildMatchups(
  rows: MatchupRow[],
  teams: Map<number, TeamInfo>,
  slots: string[],
  lookup: PlayerLookup,
) {
  const { games, unpaired } = pairByMatchup(rows);
  return {
    games: games.map(([matchup_id, g]) => {
      const sides = g.map((r) => buildTeamDetail(r, teams, slots, lookup));
      return { matchup_id, ...outcome(sides), teams: sides };
    }),
    no_matchup: unpaired.map((r) => buildTeamDetail(r, teams, slots, lookup)),
  };
}
