import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { hasProjectedStats, normalizeProjections, scoreProjections, scoreStats } from "../src/projections.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const scoring: Record<string, number> = fixture("league.json").scoring_settings;

test("primary (api.sleeper.com) array shape normalizes with opponent", () => {
  const raw = fixture("projections_primary_week4.json");
  assert.ok(Array.isArray(raw));
  const out = normalizeProjections(raw);
  // Primary also carries ADP-only entries (IR / inactive, no opponent). Those are not projections.
  const adpOnly = raw.filter((e: any) => !hasProjectedStats(e.stats));
  assert.ok(adpOnly.length > 0 && adpOnly.every((e: any) => e.opponent == null));
  assert.equal(Object.keys(out).length, raw.length - adpOnly.length);
  assert.equal(out["6804"].opponent, raw.find((e: any) => e.player_id === "6804").opponent);
  assert.equal(out["6804"].stats.pass_yd, 248.69);
});

test("v1 bare endpoint returning only {} is treated as a failure", () => {
  const raw = fixture("projections_v1_week4.json");
  assert.ok(Object.values(raw).every((s) => Object.keys(s as object).length === 0));
  assert.deepEqual(normalizeProjections(raw), {});
});

test("v1 map shape keeps real stat lines and drops ADP-only entries", () => {
  const raw = fixture("projections_v1_regular_week4.json");
  const adpOnly = Object.keys(raw).filter((k) => !hasProjectedStats(raw[k]));
  assert.ok(adpOnly.length >= 50);
  const out = normalizeProjections(raw);
  for (const k of adpOnly) assert.ok(!(k in out));
  assert.equal(out["6804"].stats.pass_yd, 248.69);
  assert.equal(out["6804"].opponent, null);
});

test("map of { stats } objects is handled", () => {
  const out = normalizeProjections({ "1": { stats: { rec: 3 }, opponent: "KC" }, "2": { stats: { adp_dd_ppr: 4 } } });
  assert.deepEqual(out, { "1": { stats: { rec: 3 }, opponent: "KC" } });
});

test("scoring reproduces Sleeper's own week 3 points for every rostered player", () => {
  const stats = new Map<string, Record<string, number>>(
    fixture("stats_week3.json").map((e: any) => [e.player_id, e.stats]),
  );
  let checked = 0;
  for (const row of fixture("matchups_week3.json")) {
    for (const [pid, pts] of Object.entries<number>(row.players_points)) {
      const s = stats.get(pid);
      if (!s) continue;
      assert.ok(Math.abs(scoreStats(s, scoring).points - pts) < 0.011, `${pid}: ${pts}`);
      checked++;
    }
  }
  assert.ok(checked > 250);
});

test("league scoring differs from generic PPR (pass_td 4, pass_yd 0.04, pass_int -1)", () => {
  // 6804: generic pts_ppr 17.14. League scoring of the same line is computed, not copied.
  const line = scoreStats(normalizeProjections(fixture("projections_primary_week4.json"))["6804"].stats, scoring);
  assert.notEqual(line.points, 17.14);
  assert.ok(!line.unscored.includes("pts_ppr") && line.meta.includes("pts_ppr"));
});

test("fgmiss total is derived from distance buckets and scored", () => {
  const line = scoreStats({ xpm: 2, fgmiss_30_39: 0.1, fgmiss_50p: 0.2 }, scoring);
  assert.deepEqual(line.derived, ["fgmiss"]);
  assert.equal(line.points, 2 - 0.3);
  assert.deepEqual(line.unscored.sort(), ["fgmiss_30_39", "fgmiss_50p"]);
  // Present total is not double counted.
  assert.equal(scoreStats({ fgmiss: 1, fgmiss_40_49: 1 }, scoring).points, -1);
});

test("unscored stat keys are surfaced with counts", () => {
  const proj = normalizeProjections(fixture("projections_primary_week4.json"));
  const scored = scoreProjections(proj, ["6804", "8259", "HOU", "nope"], scoring);
  assert.equal(scored.points.size, 3);
  assert.ok(scored.unscored_stat_keys.pass_att >= 1);
  assert.ok(scored.unscored_stat_keys.yds_allow >= 1);
  assert.ok(!("pass_yd" in scored.unscored_stat_keys));
  assert.ok(scored.ignored_meta_keys.includes("adp_dd_ppr"));
  assert.deepEqual(scored.derived_stat_keys, ["fgmiss"]);
});
