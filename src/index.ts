import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildMatchups, buildScoreboard } from "./matchups";
import { scoreProjections, type ScoredSet } from "./projections";
import {
  type Env,
  type NflState,
  type Projections,
  type SleeperPlayer,
  getLeague,
  getLeagueUsers,
  getMatchups,
  getNflState,
  getPlayersMap,
  getProjections,
  getRosters,
  getTradedPicks,
  getTransactions,
  getUser,
  getUserLeagues,
  isWaiverEligible,
  playerName,
  resolveIds,
  teamIndex,
  weekStatus,
} from "./sleeper";

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function leagueIdOf(env: Env, override?: string | null) {
  const id = override || env.SLEEPER_LEAGUE_ID;
  if (!id) throw new Error("Pass league_id or set SLEEPER_LEAGUE_ID on the Worker.");
  return id;
}

/** Projections for a league's season. Postseason projections only exist for the live season. */
async function leagueProjections(
  env: Env,
  league: { season: string },
  week: number,
  state: NflState,
): Promise<Projections> {
  const seasonType = league.season === state.season && state.season_type === "post" ? "post" : "regular";
  return getProjections(env, league.season, week, seasonType);
}

function projectionSummary(proj: Projections, scored: ScoredSet) {
  return {
    available: true,
    source: proj.source,
    ...(proj.fallbacks.length ? { fallbacks: proj.fallbacks } : {}),
    points_basis: "league scoring_settings",
    unscored_stat_keys: scored.unscored_stat_keys,
    ignored_meta_keys: scored.ignored_meta_keys,
    derived_stat_keys: scored.derived_stat_keys,
  };
}

function playerInfo(map: Record<string, SleeperPlayer>) {
  return (id: string) => {
    const p = map[id];
    return { name: playerName(p), position: p?.position || null, team: p?.team || null };
  };
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "sleeper-mcp",
    version: "0.1.1",
  });

  server.tool(
    "get_nfl_state",
    "Current NFL week and season from Sleeper.",
    {},
    async () => text(await getNflState()),
  );

  server.tool(
    "get_user",
    "Look up a Sleeper user by username or user_id.",
    { username: z.string() },
    async ({ username }) => text(await getUser(username)),
  );

  server.tool(
    "list_leagues",
    "List NFL leagues for a Sleeper user in a season.",
    {
      username: z.string().optional(),
      season: z.string().optional(),
    },
    async ({ username, season }) => {
      const uname = username || env.SLEEPER_USERNAME;
      if (!uname) throw new Error("Pass username or set SLEEPER_USERNAME.");
      const user = await getUser(uname);
      const year = season || (await getNflState()).season;
      const leagues = await getUserLeagues(user.user_id, year);
      return text({ user, leagues });
    },
  );

  server.tool(
    "get_league_snapshot",
    "Full league snapshot: settings, owners, every roster with resolved player names. Use this before waiver or trade advice.",
    { league_id: z.string().optional() },
    async ({ league_id }) => {
      const id = leagueIdOf(env, league_id);
      const [league, rosters, users, map] = await Promise.all([
        getLeague(id),
        getRosters(id),
        getLeagueUsers(id),
        getPlayersMap(env),
      ]);
      const index = teamIndex(rosters, users);
      const teams = rosters.map((r) => {
        const info = index.get(r.roster_id);
        return {
          roster_id: r.roster_id,
          owner_id: r.owner_id,
          owner_name: info?.owner_name || "Open",
          team_name: info?.team_name || null,
          record: r.settings
            ? `${r.settings.wins || 0}-${r.settings.losses || 0}-${r.settings.ties || 0}`
            : null,
          starters: resolveIds(r.starters, map),
          bench: resolveIds(
            (r.players || []).filter((p) => !(r.starters || []).includes(p)),
            map,
          ),
          ir: resolveIds(r.reserve, map),
          taxi: resolveIds(r.taxi, map),
        };
      });
      return text({ league, teams });
    },
  );

  server.tool(
    "get_free_agents",
    "Players not on any roster in the league who currently have an NFL team. Filter by position. This is the only valid waiver list. Retired and unsigned names are excluded even if Sleeper left them Active with a stale search_rank.",
    {
      league_id: z.string().optional(),
      position: z.string().optional(),
      limit: z.number().optional(),
    },
    async ({ league_id, position, limit }) => {
      const id = leagueIdOf(env, league_id);
      const [rosters, map] = await Promise.all([getRosters(id), getPlayersMap(env)]);
      const owned = new Set<string>();
      for (const r of rosters) {
        for (const p of r.players || []) owned.add(p);
        for (const p of r.reserve || []) owned.add(p);
        for (const p of r.taxi || []) owned.add(p);
      }
      const pos = position?.toUpperCase();
      const max = Math.min(limit || 40, 100);
      const agents = Object.values(map)
        .filter((p) => {
          if (!p || owned.has(p.player_id)) return false;
          if (!isWaiverEligible(p)) return false;
          if (pos) {
            const positions = (p.fantasy_positions || [p.position]).filter(Boolean);
            if (!positions.includes(pos)) return false;
          }
          return true;
        })
        .sort((a, b) => (a.search_rank || 9999) - (b.search_rank || 9999))
        .slice(0, max)
        .map((p) => ({
          id: p.player_id,
          name: playerName(p),
          position: p.position,
          team: p.team,
          injury: p.injury_status || null,
          search_rank: p.search_rank || null,
        }));
      return text({ count: agents.length, position: pos || "ALL", players: agents });
    },
  );

  server.tool(
    "get_transactions",
    "Waiver, free-agent, and trade transactions for a week (round).",
    {
      league_id: z.string().optional(),
      week: z.number().optional(),
    },
    async ({ league_id, week }) => {
      const id = leagueIdOf(env, league_id);
      const state = await getNflState();
      const round = week || state.week || 1;
      return text({ week: round, transactions: await getTransactions(id, round) });
    },
  );

  server.tool(
    "get_traded_picks",
    "All traded future draft picks in the league.",
    { league_id: z.string().optional() },
    async ({ league_id }) => {
      const id = leagueIdOf(env, league_id);
      return text(await getTradedPicks(id));
    },
  );

  server.tool(
    "find_trade_fits",
    "Roster construction by position for every team. Use to spot WR-poor / RB-rich clubs.",
    { league_id: z.string().optional() },
    async ({ league_id }) => {
      const id = leagueIdOf(env, league_id);
      const [rosters, users, map] = await Promise.all([
        getRosters(id),
        getLeagueUsers(id),
        getPlayersMap(env),
      ]);
      const index = teamIndex(rosters, users);
      const counts = rosters.map((r) => {
        const byPos: Record<string, string[]> = {};
        for (const pid of r.players || []) {
          const p = map[pid];
          const pos = p?.position || "UNK";
          byPos[pos] ||= [];
          byPos[pos].push(playerName(p));
        }
        return {
          roster_id: r.roster_id,
          owner: index.get(r.roster_id)?.owner_name || "Open",
          counts: Object.fromEntries(Object.entries(byPos).map(([k, v]) => [k, v.length])),
          players: byPos,
        };
      });
      return text(counts);
    },
  );

  server.tool(
    "get_scoreboard",
    "Every head-to-head matchup in a week as team vs team with point totals only. Defaults to the current NFL week.",
    {
      league_id: z.string().optional(),
      week: z.number().optional(),
    },
    async ({ league_id, week }) => {
      const id = leagueIdOf(env, league_id);
      const state = await getNflState();
      const round = week || state.week || 1;
      const [rows, rosters, users] = await Promise.all([
        getMatchups(env, id, round, state),
        getRosters(id),
        getLeagueUsers(id),
      ]);
      return text({
        week: round,
        week_status: weekStatus(round, state),
        ...buildScoreboard(rows, teamIndex(rosters, users)),
      });
    },
  );

  server.tool(
    "get_matchups",
    "Head-to-head matchups for a week: both teams' totals, every starter by lineup slot with points, and bench players with points. Includes league-scored projections when available; still works without them. Defaults to the current NFL week.",
    {
      league_id: z.string().optional(),
      week: z.number().optional(),
    },
    async ({ league_id, week }) => {
      const id = leagueIdOf(env, league_id);
      const state = await getNflState();
      const round = week || state.week || 1;
      const [league, rows, rosters, users, map] = await Promise.all([
        getLeague(id),
        getMatchups(env, id, round, state),
        getRosters(id),
        getLeagueUsers(id),
        getPlayersMap(env),
      ]);

      let projected: ((pid: string) => number | null) | undefined;
      let projections: Record<string, unknown>;
      try {
        if (!league.scoring_settings) throw new Error("League has no scoring_settings.");
        const proj = await leagueProjections(env, league, round, state);
        const ids = rows.flatMap((r) => r.players || []);
        const scored = scoreProjections(proj.players, ids, league.scoring_settings);
        projected = (pid) => scored.points.get(pid) ?? null;
        projections = projectionSummary(proj, scored);
      } catch (e) {
        projections = { available: false, error: e instanceof Error ? e.message : String(e) };
      }

      const slots = league.roster_positions.filter((p) => !["BN", "IR", "TAXI"].includes(p));
      return text({
        week: round,
        week_status: weekStatus(round, state),
        projections,
        ...buildMatchups(rows, teamIndex(rosters, users), slots, { player: playerInfo(map), projected }),
      });
    },
  );

  server.tool(
    "get_projections",
    "Projected fantasy points for a week, computed from projected stat lines with this league's scoring_settings (not generic PPR). Pass player_ids for specific players with full stat lines; otherwise returns every rostered player in the league. Lists any projected stat with no league scoring rule. Defaults to the current NFL week.",
    {
      league_id: z.string().optional(),
      week: z.number().optional(),
      player_ids: z.array(z.string()).optional(),
    },
    async ({ league_id, week, player_ids }) => {
      const id = leagueIdOf(env, league_id);
      const state = await getNflState();
      const round = week || state.week || 1;
      const [league, rosters, users, map] = await Promise.all([
        getLeague(id),
        getRosters(id),
        getLeagueUsers(id),
        getPlayersMap(env),
      ]);
      if (!league.scoring_settings) throw new Error("League has no scoring_settings.");
      const proj = await leagueProjections(env, league, round, state);

      const index = teamIndex(rosters, users);
      const rosteredBy = new Map<string, string>();
      for (const r of rosters) {
        const info = index.get(r.roster_id);
        for (const pid of r.players || []) rosteredBy.set(pid, info?.team_name || info?.owner_name || `Roster ${r.roster_id}`);
      }
      const ids = player_ids?.length ? [...new Set(player_ids)] : [...rosteredBy.keys()];
      const scored = scoreProjections(proj.players, ids, league.scoring_settings);
      const info = playerInfo(map);
      const players = ids
        .map((pid) => ({
          id: pid,
          ...info(pid),
          opponent: proj.players[pid]?.opponent ?? null,
          fantasy_team: rosteredBy.get(pid) || null,
          projected_points: scored.points.get(pid) ?? null,
          ...(player_ids?.length ? { stats: proj.players[pid]?.stats ?? null } : {}),
        }))
        .sort((a, b) => (b.projected_points ?? -1e9) - (a.projected_points ?? -1e9));

      return text({
        season: proj.season,
        week: round,
        ...projectionSummary(proj, scored),
        count: players.length,
        no_projection: players.filter((p) => p.projected_points == null).map((p) => p.id),
        players,
      });
    },
  );

  return server;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, mcp-session-id, MCP-Protocol-Version",
  "Access-Control-Expose-Headers": "mcp-session-id",
};

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json(
        {
          name: "sleeper-mcp",
          mcp: "/mcp",
          transport: "streamable-http",
          docs: "https://github.com/merimeesoftware/sleeper-mcp",
        },
        { headers: cors },
      );
    }

    if (url.pathname === "/mcp" && request.method === "GET") {
      return new Response("Method Not Allowed. Use POST for Streamable HTTP.", {
        status: 405,
        headers: {
          ...cors,
          Allow: "POST, DELETE, OPTIONS",
          "Content-Type": "text/plain",
        },
      });
    }

    const server = createServer(env);
    return createMcpHandler(server)(request, env, ctx);
  },
};
