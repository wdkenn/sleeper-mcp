import { normalizeProjections, type ProjectionEntry } from "./projections";
import type { MatchupRow, TeamInfo } from "./matchups";

const BASE = "https://api.sleeper.app/v1";
/** Undocumented; what Sleeper's own app uses for projections. */
const BASE_COM = "https://api.sleeper.com";
const PLAYERS_KEY = "players:nfl";
const PLAYERS_TTL = 60 * 60 * 24;
const PROJECTIONS_TTL = 60 * 30;
const LIVE_TTL = 60; // KV minimum
const RECENT_WEEK_TTL = 60 * 60 * 24; // last week can still get stat corrections
const COMPLETED_WEEK_TTL = 60 * 60 * 24 * 30;
const PROJECTION_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];

export type Env = {
  CACHE: KVNamespace;
  RATE_LIMITER: RateLimit;
  /** Encrypted Worker secret. Never in wrangler.toml or the repo. */
  MCP_AUTH_TOKEN?: string;
  SLEEPER_USERNAME?: string;
  SLEEPER_LEAGUE_ID?: string;
};

export type SleeperPlayer = {
  player_id: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  position?: string;
  fantasy_positions?: string[];
  team?: string | null;
  status?: string;
  injury_status?: string | null;
  search_rank?: number;
  active?: boolean;
};

export type SleeperUser = {
  user_id: string;
  username?: string;
  display_name?: string;
  metadata?: { team_name?: string } | null;
};

export type NflState = { week: number; season: string; season_type: string; display_week: number };

export type SleeperRoster = {
  roster_id: number;
  owner_id: string | null;
  players: string[] | null;
  starters: string[] | null;
  reserve?: string[] | null;
  taxi?: string[] | null;
  settings?: Record<string, number>;
};

async function getJson<T>(path: string, base = BASE): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Sleeper ${res.status} ${path}`);
  }
  return res.json() as Promise<T>;
}

export function playerName(p?: SleeperPlayer | null): string {
  if (!p) return "Unknown";
  if (p.full_name) return p.full_name;
  return [p.first_name, p.last_name].filter(Boolean).join(" ") || p.player_id;
}

/** Waiver-eligible: on an NFL roster. Sleeper leaves retired names Active with a stale search_rank. */
export function isWaiverEligible(p?: SleeperPlayer | null): boolean {
  if (!p) return false;
  if (p.active === false) return false;
  if (p.status && p.status !== "Active") return false;
  if (!p.team) return false;
  return Boolean(p.position || p.fantasy_positions?.length);
}

/** KV read-through. Keys are `kind:scope[:...]`. KV rejects TTLs under 60s. */
async function cachedJson<T>(env: Env, key: string, ttl: number, load: () => Promise<T>): Promise<T> {
  const cached = await env.CACHE.get(key, "json");
  if (cached != null) return cached as T;
  const data = await load();
  await env.CACHE.put(key, JSON.stringify(data), { expirationTtl: Math.max(ttl, 60) });
  return data;
}

export function ownerName(u?: SleeperUser | null): string {
  return u?.display_name || u?.username || "Open";
}

/** roster_id -> owner and team name. Team name is the user's league-specific metadata.team_name. */
export function teamIndex(rosters: SleeperRoster[], users: SleeperUser[]): Map<number, TeamInfo> {
  const owners = new Map(users.map((u) => [u.user_id, u]));
  return new Map(
    rosters.map((r) => {
      const owner = r.owner_id ? owners.get(r.owner_id) : undefined;
      return [
        r.roster_id,
        {
          owner_id: r.owner_id,
          owner_name: ownerName(owner),
          team_name: owner?.metadata?.team_name?.trim() || null,
        },
      ];
    }),
  );
}

export async function getNflState() {
  return getJson<NflState>("/state/nfl");
}

export async function getUser(usernameOrId: string) {
  return getJson<SleeperUser>(`/user/${encodeURIComponent(usernameOrId)}`);
}

export async function getUserLeagues(userId: string, season: string) {
  return getJson<Array<{ league_id: string; name: string; season: string; total_rosters: number }>>(
    `/user/${userId}/leagues/nfl/${season}`,
  );
}

export async function getLeague(leagueId: string) {
  return getJson<{
    league_id: string;
    name: string;
    season: string;
    roster_positions: string[];
    scoring_settings?: Record<string, number>;
    settings?: Record<string, number>;
  }>(`/league/${leagueId}`);
}

export async function getRosters(leagueId: string) {
  return getJson<SleeperRoster[]>(`/league/${leagueId}/rosters`);
}

export async function getLeagueUsers(leagueId: string) {
  return getJson<SleeperUser[]>(`/league/${leagueId}/users`);
}

export async function getTransactions(leagueId: string, week: number) {
  return getJson<unknown[]>(`/league/${leagueId}/transactions/${week}`);
}

export async function getTradedPicks(leagueId: string) {
  return getJson<unknown[]>(`/league/${leagueId}/traded_picks`);
}

export async function getPlayersMap(env: Env): Promise<Record<string, SleeperPlayer>> {
  return cachedJson(env, PLAYERS_KEY, PLAYERS_TTL, () =>
    getJson<Record<string, SleeperPlayer>>("/players/nfl"),
  );
}

export type WeekStatus = "completed" | "current" | "upcoming";

export function weekStatus(week: number, state: NflState): WeekStatus {
  const inSeason = state.season_type === "regular" || state.season_type === "post";
  if (inSeason && week < state.week) return "completed";
  if (inSeason && week === state.week) return "current";
  return "upcoming";
}

/** Live weeks ~60s. Completed weeks are final apart from stat corrections to the most recent one. */
function matchupsTtl(week: number, state: NflState): number {
  if (weekStatus(week, state) !== "completed") return LIVE_TTL;
  return week === state.week - 1 ? RECENT_WEEK_TTL : COMPLETED_WEEK_TTL;
}

export async function getMatchups(env: Env, leagueId: string, week: number, state: NflState) {
  return cachedJson(env, `matchups:${leagueId}:${week}`, matchupsTtl(week, state), () =>
    getJson<MatchupRow[]>(`/league/${leagueId}/matchups/${week}`),
  );
}

export type Projections = {
  source: string;
  season: string;
  week: number;
  season_type: string;
  players: Record<string, ProjectionEntry>;
  /** Sources tried before the one that worked, with why they were rejected. */
  fallbacks: string[];
};

/**
 * Primary: api.sleeper.com (what Sleeper's app uses). Fallback: api.sleeper.app/v1, which has
 * been seen returning only {} or ADP-only entries. A response with no real stat lines is a failure.
 * Failures throw before anything is cached.
 */
export async function getProjections(
  env: Env,
  season: string,
  week: number,
  seasonType = "regular",
): Promise<Projections> {
  return cachedJson(env, `projections:nfl:${season}:${seasonType}:${week}`, PROJECTIONS_TTL, async () => {
    const positions = PROJECTION_POSITIONS.map((p) => `position[]=${p}`).join("&");
    const sources: Array<[string, string, string]> = [
      [BASE_COM, `/projections/nfl/${season}/${week}?season_type=${seasonType}&${positions}`, "api.sleeper.com"],
      [BASE, `/projections/nfl/${seasonType}/${season}/${week}`, `api.sleeper.app/v1 (${seasonType})`],
      [BASE, `/projections/nfl/${season}/${week}`, "api.sleeper.app/v1"],
    ];
    const fallbacks: string[] = [];
    for (const [base, path, source] of sources) {
      try {
        const players = normalizeProjections(await getJson<unknown>(path, base));
        if (Object.keys(players).length) {
          return { source, season, week, season_type: seasonType, players, fallbacks };
        }
        fallbacks.push(`${source}: no entries with projected stats`);
      } catch (e) {
        fallbacks.push(`${source}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw new Error(`Projections unavailable for ${season} week ${week}. ${fallbacks.join("; ")}`);
  });
}

export function resolveIds(ids: string[] | null | undefined, map: Record<string, SleeperPlayer>) {
  return (ids || []).map((id) => {
    const p = map[id];
    return {
      id,
      name: playerName(p),
      position: p?.position || null,
      team: p?.team || null,
      injury: p?.injury_status || null,
    };
  });
}
