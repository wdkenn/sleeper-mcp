# sleeper-mcp

Self-hosted **remote MCP** for [Sleeper](https://docs.sleeper.com/) fantasy football.
Deploy your own Cloudflare Worker. Paste one URL into Grok, Cursor, Claude, or any MCP client.

This repo does **not** host a public multi-tenant proxy. You run it. You pay your Worker. Sleeper rate limits hit your account, not ours.

No Sleeper login. The public API is read-only. Identity is `username` + `league_id`.

## Why this exists

Most Sleeper MCPs are local `npx` / stdio. Grok connectors and most remote harnesses want:

```text
https://sleeper-mcp.<your-account>.workers.dev/mcp
```

Free agents are computed here (NFL player map minus every rostered ID, and only players with a current NFL team). Do not recommend a player unless `get_free_agents` returns them.

## Tools

| Tool | Purpose |
|------|---------|
| `get_nfl_state` | Week / season |
| `get_user` | Profile by username |
| `list_leagues` | User leagues for a season |
| `get_league_snapshot` | Owners + named rosters |
| `get_free_agents` | True waiver list by position |
| `get_transactions` | Adds / drops / trades for a week |
| `get_traded_picks` | Future pick movement |
| `find_trade_fits` | Position counts per team |
| `get_matchups` | Head-to-head games for a week: totals, starters by slot with points, bench with points, league-scored projections when available |
| `get_scoreboard` | Every game in a week, team vs team, totals only |
| `get_projections` | Projected points scored with the league's own `scoring_settings`; rostered players by default, or pass `player_ids` for full stat lines |

`week` defaults to the current NFL week from `/v1/state/nfl`.

## Projections

Projections are **not** in Sleeper's documented API.

- **Primary:** `https://api.sleeper.com/projections/nfl/{season}/{week}?season_type=regular&position[]=QB&...` (what Sleeper's own app uses).
- **Fallback, only if the primary fails:** `https://api.sleeper.app/v1/projections/nfl/regular/{season}/{week}`, then `.../v1/projections/nfl/{season}/{week}`. The bare v1 URL has been seen returning nothing but `{}` per player.
- An entry with only ADP / rank / generic-points keys is not a projection. A response with no real stat lines counts as a failure, and the next source is tried. Failures are never cached.
- Sleeper returns projected **stat lines**, not fantasy points. Points are computed by multiplying each stat by the league's `scoring_settings` (from `GET /v1/league/{id}`), not generic PPR. Applied to week 3 2026 actuals, the same method reproduces Sleeper's own `players_points` exactly.
- Projected stats with no league scoring rule are listed in `unscored_stat_keys` (with player counts), never silently dropped. ADP / generic points keys are listed in `ignored_meta_keys`.
- Projections give missed field goals only by distance (`fgmiss_30_39`, ...). When the league scores the total `fgmiss`, it is derived from those and listed in `derived_stat_keys`.
- If projections are unavailable, `get_matchups` still returns actual scores with `projections.available: false`.

## Deploy (Cloudflare Workers Builds)

Same path as porkbun-mcp: connect this GitHub repo on the Worker. Cloudflare deploys on push. No GitHub `CLOUDFLARE_API_TOKEN`.

**Workers & Pages → `sleeper-mcp` → Settings → Build → Connect:**

| Setting | Value |
|---------|-------|
| Git account | `merimeesoftware` |
| Repository | `sleeper-mcp` |
| Production branch | `main` |
| Enable Preview builds | on |
| Build command | *(empty)* |
| Deploy command | `npx wrangler deploy` |

Leave the API token on the default Cloudflare-generated Builds token. Runtime identity stays on **Settings → Variables and Secrets** as **encrypted secrets**, not in GitHub and not in `[vars]`. Empty `SLEEPER_USERNAME` / `SLEEPER_LEAGUE_ID` in `wrangler.toml` overwrite secrets of the same name on deploy. Season is not a Worker var; `list_leagues` uses Sleeper's current NFL season unless the caller passes `season`.

First-time KV (already done for merimeesoftware):

```bash
npx wrangler kv namespace create sleeper-mcp-cache
```

Put the returned id in `wrangler.toml` under `kv_namespaces[0].id`.

Optional defaults (or pass IDs on every tool call):

```bash
npx wrangler secret put SLEEPER_USERNAME
npx wrangler secret put SLEEPER_LEAGUE_ID
```

League ID is the number in `https://sleeper.com/leagues/<id>/...`.

Manual deploy from a logged-in machine:

```bash
npm run deploy
```

MCP URL:

```text
https://sleeper-mcp.<your-subdomain>.workers.dev/mcp
```

## Connect

**Grok:** grok.com → Connectors → New → Custom → paste the **full** `/mcp` URL, including `https://`. The field can crop the left side (`leeper-mcp...`); confirm the stored value is not missing `https://` before Add.

Streamable HTTP is POST-only. `GET /mcp` returns **405** immediately (`Allow: POST`) so clients that probe SSE do not hang.

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "sleeper": {
      "url": "https://sleeper-mcp.<your-subdomain>.workers.dev/mcp"
    }
  }
}
```

**Grok CLI:**

```bash
grok mcp add --transport http sleeper https://sleeper-mcp.<your-subdomain>.workers.dev/mcp
```

## Local

```bash
npm run dev
```

Tests (Node's built-in runner, no extra deps) run against real responses saved in `test/fixtures/`:

```bash
npm test
```

Inspector: `npx @modelcontextprotocol/inspector@latest` → `http://localhost:8787/mcp`

## Limits

- Sleeper: stay under ~1000 req/min. KV cache: player dump 24h, projections 30 min, current-week matchups 60s, last week's matchups 24h (stat corrections), older weeks 30 days.
- Read-only. Cannot add, drop, or trade.
- Do not point a public Worker at the world without your own rate limit.

## License

MIT
