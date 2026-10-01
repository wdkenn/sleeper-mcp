import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildMatchups, buildScoreboard, pairByMatchup, type TeamInfo } from "../src/matchups.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const week3 = fixture("matchups_week3.json");
const slots = fixture("league.json").roster_positions.filter((p: string) => p !== "BN");
const teams = new Map<number, TeamInfo>(
  fixture("rosters.json").map((r: any) => {
    const u = fixture("users.json").find((x: any) => x.user_id === r.owner_id);
    return [r.roster_id, { owner_id: r.owner_id, owner_name: u.display_name, team_name: u.metadata?.team_name ?? null }];
  }),
);
const lookup = { player: (id: string) => ({ name: `P${id}`, position: null, team: null }) };

test("rows pair into 6 head-to-head games by matchup_id", () => {
  const { games, unpaired } = pairByMatchup(week3);
  assert.equal(games.length, 6);
  assert.ok(games.every(([, g]) => g.length === 2 && g[0].matchup_id === g[1].matchup_id));
  assert.equal(unpaired.length, 0);
});

test("scoreboard totals match the raw rows", () => {
  const board = buildScoreboard(week3, teams);
  const r1 = week3.find((r: any) => r.roster_id === 1);
  const game = board.games.find((g) => g.matchup_id === r1.matchup_id)!;
  const side = game.teams.find((t) => t.roster_id === 1)!;
  assert.equal(side.points, r1.points);
  assert.equal(side.team_name, "ForWhomTheBellsToll");
  assert.ok("leader" in game && "margin" in game);
});

test("starters are zipped by index with points and lineup slot, not sorted", () => {
  const { games } = buildMatchups(week3, teams, slots, lookup);
  for (const g of games) {
    for (const t of g.teams) {
      const row = week3.find((r: any) => r.roster_id === t.roster_id);
      assert.deepEqual(t.starters.map((s) => s.id), row.starters);
      assert.deepEqual(t.starters.map((s) => s.points), row.starters_points);
      assert.equal(t.starters[0].slot, "QB");
      assert.equal(t.starters.at(-1)!.slot, "DEF");
      assert.equal(t.bench.length, row.players.length - row.starters.length);
      for (const b of t.bench) assert.equal(b.points, row.players_points[b.id]);
    }
  }
});

test("custom_points overrides, empty slots, byes, and projections", () => {
  const rows = [
    { roster_id: 1, matchup_id: 1, points: 10, custom_points: 12, starters: ["A", "0"], starters_points: [10, 0], players: ["A", "B"], players_points: { A: 10, B: 3 } },
    { roster_id: 2, matchup_id: 1, points: 11, custom_points: null, starters: ["C", "D"], starters_points: [5, 6], players: ["C", "D"], players_points: { C: 5, D: 6 } },
    { roster_id: 3, matchup_id: null, points: 0, custom_points: null, starters: [], starters_points: [], players: [], players_points: {} },
  ];
  const out = buildMatchups(rows, teams, ["QB", "RB"], { ...lookup, projected: (id) => (id === "B" ? null : 7) });
  const [a, b] = out.games[0].teams;
  assert.equal(a.points, 12);
  assert.equal((a as any).points_overridden, true);
  assert.equal(out.games[0].leader, "ForWhomTheBellsToll");
  assert.equal(a.starters[1].name, "EMPTY");
  assert.equal(a.projected_total, 7);
  assert.equal(b.projected_total, 14);
  assert.equal(a.bench[0].projected, null);
  assert.equal(out.no_matchup.length, 1);
});
