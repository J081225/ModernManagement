# ST9 Investigation — Dissolve the Operations Page?

Look-first for the owner-IA question. No code changed. Evidence is
file:line. Proposed direction: dissolve Operations — email → Settings,
PM response mode → My Business, nav entry gone.

## 1. Complete inventory of Operations today

The page ([app.html:2593](../views/app.html)) is **ungated by
vertical** — nav entry and page render identically for PM and PS. It
holds **three** cards, not the two the proposal names:

| Card | What it is | Backend | Vertical fit |
|---|---|---|---|
| **Automation settings** (L2609) | Response mode: Auto-reply vs Manager review, writing `automation.autoReplyEnabled` | `/api/automation`; CONSUMED at server.js:6829 to gate PM email auto-reply (`autoReplyToMessage`) | **PM-only in effect** — see §3 |
| **Property email connection** (L2642) | Connect a dedicated property email; "resident messages flow into your inbox" | `/api/email-account/*` (connect/test/sync/delete) | PM-framed copy; the plumbing itself is vertical-neutral |
| **Knowledge base** (L2730) | Full document manager: upload PDF/TXT, add manual policy/procedure/other, list/delete | `/api/knowledge` (GET/POST/PUT/DELETE/upload) | **Both** verticals |

**The proposal missed the Knowledge base card entirely** — and it is
the load-bearing one. It writes the SAME `/api/knowledge` table that
My Business's "Business Description / Hours of Operation / Policies"
fields ([app.html:3797+](../views/app.html)) write. So knowledge already
has TWO owner surfaces: Operations = the general document manager
(uploads, arbitrary policies), My Business = three curated named
entries. They are two views of one table, not duplicates — but any
dissolution has to decide where the document-manager half lands.

## 2. What breaks on a move

**Suite pins: nothing.** Grep of scripts/*.js for `operations`,
`page-operations`, `Property email`, `Automation settings`,
`Knowledge base`, `autoReplyEnabled` → zero hits. No gate pins these
cards' location. (The ST2 rename had the same clean bill and it held.)

**Routes/ids stay stable — the ST2 lesson applies cleanly.** Every
backend is id/route-based, not page-based: `/api/automation`,
`/api/email-account/*`, `/api/knowledge/*` don't care which page hosts
the card. Move the visible cards, keep the routes, keep the tool
`update_knowledge`'s behavior.

**Claims census — two internal references, no user-facing copy:**
- `TOOL_PAGE_MAP.update_knowledge: ['my-business', 'operations']`
  ([app.html:10197](../views/app.html)) — the HN5 refresh map. Drop
  `'operations'` when the card moves; add the card's new home.
- `showPage`'s title map ([app.html:4687](../views/app.html)) has
  `operations: 'Operations'` — harmless to leave, cleaner to remove.
- Zero references in signup emails, owner tasks, AI prompts, or tool
  copy. No deep links. Nothing points a user at "Operations" by name.

**One real fragility, PRE-EXISTING, flag it:** the home quick-tiles
and stat-tiles pass the nav element to `showPage` via **positional**
`#sidebar nav a:nth-child(N)` selectors ([app.html:2432](../views/app.html)
etc.). They're used only for active-highlighting. Removing the
Operations nav entry shifts every index after it. Worse, they already
look stale (the operations tile claims `nth-child(3)` but Operations
is the 4th nav `<a>`) — so this is a latent bug the dissolution would
disturb, not create. **Recommend: convert these to
`getElementById('nav-…')` in the same arc** (the robust pattern the
nav entries already support), so the move can't silently mis-highlight.

## 3. PM response mode + what a PS owner sees today

**Two DIFFERENT AI-response mechanisms exist, and this matters:**
- `automation.autoReplyEnabled` — the Operations "response mode",
  consumed ONLY on the PM email path (server.js:6829). A PS workspace
  gets nothing from it; the PS engine is gated by
  `workspaces.appointment_auto_respond` instead.
- `workspaces.appointment_auto_respond` — the PS "How your assistant
  works" toggle already on My Business ([app.html:3905](../views/app.html)).

So the proposal's "PM response mode → My Business (it's conduct)" is
right, but the nuance is: My Business would then host BOTH conduct
controls — the PS auto-respond card and a PM response-mode card —
each shown to its own vertical. That's coherent (My Business = how the
business behaves, per vertical) as long as the PM card renders
**only for PM** and the PS card **only for PS**. Today neither the
Operations page nor "How your assistant works" is vertical-gated, so
this move must ADD gating that doesn't exist yet.

**What a PS salon sees on Operations today (the near-empty case the
proposal anticipated, confirmed and worse):** all three cards, one of
them ("Automation settings") governing a PM-only code path that does
nothing for them, and another ("Property email connection") whose copy
talks about "resident messages" and a "property email" — actively
wrong for a salon. For the PS vertical the page is not just sparse,
it's mis-framed.

## 4. Recommended commit sequence + surprises

**Recommendation: dissolve, yes — but as FOUR moves, not two, and
gate as you go.**

- **ST10a — Knowledge base card → its home.** The proposal omitted
  it; it must be placed deliberately. Recommend **My Business**
  (knowledge is what the assistant knows — it belongs with the
  assistant's conduct and the curated Description/Hours/Policies that
  already live there), NOT Settings. One card moves; `/api/knowledge`
  unchanged; update `TOOL_PAGE_MAP`.
- **ST10b — Property email connection → Settings**, beside business
  identity (account plumbing, per the proposal). Re-word the PM-framed
  copy to be vertical-neutral ("business email" not "property email"),
  since Settings serves both.
- **ST10c — PM response mode → My Business**, gated PM-only, and gate
  the existing PS "How your assistant works" card PS-only in the same
  commit (the gating debt is paid where it's introduced).
- **ST10d — remove the Operations nav entry + page shell**, convert
  the positional nth-child nav selectors to id-based, drop the
  `operations` entries from TOOL_PAGE_MAP and the title map. Suite row
  pinning: no Operations nav, both moved cards present at their new
  homes, the two conduct cards each vertical-gated.

**Surprises to surface before ruling:**
1. **The Knowledge base card is the real content of Operations** and
   the proposal didn't mention it — §4 needs your ruling on its home
   (My Business recommended).
2. **Gating is being ADDED, not preserved** — today Operations and
   "How your assistant works" are ungated; the clean end-state needs
   per-vertical gating that doesn't exist yet. That's new behavior,
   worth an explicit nod.
3. **The nth-child nav fragility is pre-existing and already stale** —
   fold the id-based conversion into ST10d or it becomes a mis-
   highlight bug the moment the nav shrinks.

## Rulings for Jay
1. Knowledge base card home: **My Business** (recommended) or Settings?
2. Confirm PM response mode + PS "How your assistant works" both
   become **vertical-gated** on My Business (new behavior).
3. Property email copy re-worded vertical-neutral for Settings — ok?
4. Sequence ST10a→d approved? The nth-child→id conversion folded into
   ST10d — ok?
