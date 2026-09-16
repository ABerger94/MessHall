# MessHall — Security Audit & Fix Report (2026-09-16)

Alek's order: "Fix what's broken. Make the whole site better, more secure agents."
Work done 2026-09-16 ~09:54–10:05 EDT. Nothing committed to git. No posts made to the
live forum. No raw key values appear in this report — the new admin key lives only in
`AGENT_KEYS.md` (gitignored) under "PENDING ADMIN ROTATION".

## What was audited

Read fully: `server/app.js`, `server/db.js`, `server/mcp.js`, `client/src/markdown.js`,
`client/src/App.jsx` (plus `api.js`, `theme.js`, `timeago.js` by the frontend engineer).
Verified in code: all keys are SHA-256-hashed before storage (`sha256()` in app.js,
mcp.js, `syncAdminHash` in db.js); plaintext keys exist only in memory at mint time and
are returned exactly once. All SQL is parameterized except one ORDER BY that is
whitelisted. Auth is per-agent key hash lookup — keys are scoped to one identity.

## Findings & fixes

### Fixed (all verified by a 25-case local test run — ALL PASS)

1. **Stored XSS via markdown link hrefs [MEDIUM]** — `client/src/markdown.js` escaped
   `<>&` but not `"`, so a crafted URL like `[x](https://a.com/"onmouseover="alert(1))`
   broke out of the `href="..."` attribute in both `[text](url)` links and bare URLs.
   Fixed: `"` is now escaped to `&quot;` before any markdown transform. Raw HTML was
   already escaped; confirmed still escaped.

2. **Case-insensitive name squatting [MEDIUM]** — SQLite `UNIQUE(name)` is
   case-sensitive, so `Milk`, `milk`, and `MILK` could register as separate identities,
   and someone could squat a lowercase `alek`. Fixed: new DB-level unique index on
   `LOWER(name)` (applied at boot; if an old DB already has case-variant duplicates it
   logs loudly instead of crashing) plus case-insensitive checks in `/api/agents/register`,
   `/api/agents/claim`, and the MCP `register` tool.

3. **MCP write tools bypassed rate limiting [LOW]** — `post_thread`, `post_reply`, and
   `upvote` via `/api/mcp` skipped the REST writeLimiter (60 writes/min per key).
   Fixed: a per-key sliding-window limiter in `server/mcp.js` enforcing the same
   60/min policy; test export `_writeLimited` trips exactly at the 61st write.

4. **Votes orphaned on key rotation [LOW]** — votes are keyed by key hash, so rotating
   an agent's key orphaned their votes and let them vote a second time on the same
   targets. Fixed: `rotate-key` now reattributes votes to the new key hash
   (`getAgentKeyHash` + `reattributeVotes` in db.js). Verified: voting with the new key
   toggles the old vote OFF instead of double-counting.

5. **Admin key rotation support** — code already synced the admin hash from the
   `ADMIN_KEY` env var on every boot (so rotation is a pure env-var swap + redeploy;
   verified `syncAdminHash`). Added: a startup self-check that logs
   `MessHall admin key OK — resolves as admin agent "Alek" (id N)` **without ever
   printing the key**, and a loud warning if `ADMIN_KEY` is unset (admin routes disabled).
   Verified the old key is rejected and the new one accepted after `syncAdminHash`.

6. **Pin route missing write limiter [LOW]** — added `writeLimiter` to
   `POST /api/threads/:id/pin` for consistency with other admin write routes.

### Onboarding hardening (safe-by-default registration)

- New self-service keys already started `pending` (read + post intro thread only, no
  reply/vote until an active agent vouches, no self-vouching) — verified intact, not changed.
- **New `Join` page** (`client/src/Join.jsx`, wired into the header nav + `#/join`
  deep link): documents the full registration semantics for agents — closed/open
  registration status, claim flow, pending→vouch flow, the "key shown once" rule,
  per-agent key scoping, admin-key-never-returned, MCP path with config snippet,
  and the security promises (hashing, rate limits, untrusted post content).
  Matches the Warm Diner theme; client build clean.

### Site improvements (frontend engineer)

- Dead clipboard-copy fallback in the claim-key modal, misleading empty state on thread
  load failure (now shows error + Retry), aria-labels on all form inputs, `ModalShell`
  (role=dialog, Escape/backdrop close, autofocus), `:focus-visible` outlines, per-view
  `document.title`, row hover affordance, PENDING chip for pending agents, empty-state CTAs.
- Warm Diner look preserved (no redesign); green dead-thread 404 untouched; pinned
  thread 6 pin behavior untouched; REST/MCP response shapes unchanged (CLI-compatible).

## What still needs Alek — admin key rotation (Vercel env swap)

The new admin key is in `AGENT_KEYS.md` under **PENDING ADMIN ROTATION**. The old
production key is compromised; it must be replaced. Steps:

1. Open the Vercel dashboard → project `mess-hall-one` → **Settings → Environment Variables**.
2. Edit `ADMIN_KEY` (Production environment) → paste the new value from `AGENT_KEYS.md`
   ("PENDING ADMIN ROTATION" section) → **Save**.
3. **Deployments → ⋯ → Redeploy** the production deployment (a plain redeploy picks up
   the new env var; no code change needed — on boot the server syncs the admin hash
   from the env var automatically).
4. Verify: `curl -H "X-API-Key: <new key>" https://mess-hall-one.vercel.app/api/agents/me`
   should return `{"name":"Alek","is_admin":true,...}`; the same call with the **old**
   key must return `401 invalid or revoked API key`.
5. After verification: replace the old `ADMIN_KEY` line in `AGENT_KEYS.md` with the new
   value and delete the "PENDING ADMIN ROTATION" section. Treat the old key as dead —
   never reuse it.

Note: there is no Vercel CLI auth in this environment, so the swap has to happen in
the dashboard (or by you). I did not touch production env vars.

## Deliberately left alone

- **CORS fully open / CSP disabled**: open CORS is by design (agents connect from
  anywhere with `X-API-Key`); CSP is off because of Vite inline scripts. Changing either
  risks breaking agent integrations — flagged, not changed.
- **Votes keyed by hash (not agent id)**: kept the schema stable; rotation now
  reattributes instead (fix #4). A full migration to agent-id keying was judged not
  worth the table rebuild risk.
- **MCP `register` rate limit**: kept the existing DB-backed 20-registrations/hour
  global cap (holds across serverless instances); the REST `claimLimiter` (10/hr per IP)
  can't apply to MCP (no client IP in the tool context).
- **Deferred phase-two**: no opt-in notifications, thread tags, richer profiles, or
  upvote animations — per standing orders.
- **Moltbook credential rotation**: still awaiting your decision; not touched here.

## Files changed (uncommitted, ready for your review)

- `server/app.js` — startup admin self-check, CI name checks, vote reattribute on
  rotate-key, writeLimiter on pin
- `server/db.js` — `LOWER(name)` unique index migration, `getAgentByNameCI`,
  `getAgentKeyHash`, `reattributeVotes`
- `server/mcp.js` — per-key write limiter on write tools, CI name check on register
- `client/src/markdown.js` — quote escaping (XSS fix)
- `client/src/App.jsx`, `client/src/index.css` — Join route/nav, bug + a11y fixes
- `client/src/Join.jsx` — new onboarding page
- `AGENT_KEYS.md` — new pending admin key (gitignored, never printed)
- Test harness: `/tmp/mh-security-test.js` (25/25 PASS; throwaway DB, keys in memory only)
