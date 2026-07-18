# Phase 2 — Color Role Mapping (dark → light inversion of `views/app.html`)

## Inputs

- Prior audit: `docs/design-audit-2026-07-17.md` (read in full; line numbers below were re-verified against the live file, which has drifted slightly from the audit).
- Target tokens: `public/css/design-system.css` (light-mode `:root`, lines 19-59). Key values referenced below: `--bg-page #f6f7f9` (`public/css/design-system.css:20`), `--bg-surface #ffffff` (`:21`), `--bg-sunken #eef0f3` (`:22`), `--bg-hover #f3f4f6` (`:23`), `--text-primary #1f2937` (`:25`), `--text-secondary #4b5563` (`:26`), `--text-muted #6b7280` (`:27`), `--text-on-accent #ffffff` (`:28`), `--border #e3e7ec` (`:30`), `--border-strong #c9d0d9` (`:31`), `--accent #1a5f3f` (`:33`), `--accent-hover #14492f` (`:34`), `--accent-soft #e8f2ed` (`:35`), `--shadow-card`/`--shadow-popup` composites (`:49-50`).
- Inverted file: `views/app.html` (13,446 lines; primary `<style>` block `views/app.html:17-2254`, tiny secondary block `views/app.html:8923-8925`).

**Method for every count below.** Occurrence counts were derived with `grep -o` (true occurrences, not matching lines — inline styles pack several colors per line). Per-role splits were derived with a position-aware classifier that reads the governing CSS property before each match (`color:`→text, `border*`/`outline*`→border, `background*`→background, `*shadow`→shadow, inside `*-gradient(`→gradient stop, `fill`/`stroke`→icon fill, `accent-color`→interactive). Three residual buckets were resolved by reading the cited lines: (a) **CSS comments** that list the palette (`views/app.html:910`, `:1864-1865`, `:2052-2053`) are excluded from role counts; (b) **multi-line `box-shadow`/gradient declarations** (property on a prior line) were folded into shadow / gradient-stop by reading each block; (c) **JS-injected** occurrences (line > 2254, inside template strings / `onmouseover` handlers) are counted but flagged as hand-edit-only. Where a per-role split could not be cleanly separated it is stated inline.

---

## Main mapping table — solid hex literals

Context legend: **S** = inside the `<style>` block (`views/app.html:17-2254`); **I** = inline `style="…"` attribute or JS-generated markup (line > 2254). Distribution (S vs outside) is grep-derived per literal.

| literal | role | count (role) | example `views/app.html:` | S / I | proposed token |
| --- | --- | --- | --- | --- | --- |
| `#f5e6d3` (145 total; S43/I102) | text (primary, Tier 1) | 137 | :179, :244, :462 | both | `--text-primary` |
| `#f5e6d3` | background (toggle-thumb knob) | 1 | :3295 | I | **NEEDS DECISION** — decorative UI knob fill; light thumb on grey track ⇒ `--bg-surface`? |
| `#f5e6d3` | gradient stop | 2 | :788, :1307 | S | **NEEDS DECISION** — text-fill gradient (keep as `--text-primary`) or decorative banner fill (DELETE)? |
| `#e2e8f0` (102 total; S30/I72) | text (secondary, Tier 3) | 41 | :30, :164, :251 | both | `--text-secondary` |
| `#e2e8f0` | border | 45 | :119, :433, :1631 | both | `--border` (hairline dividers dominate; 1.5px input frames e.g. `:433`, `:516` ⇒ `--border-strong`) |
| `#e2e8f0` | background (light fill) | 6 | :473, :1745, :3194 | both | `--bg-sunken` |
| `#94a3b8` (223 total; S32/I191) | text (muted, Tier 4) | 201 | :132, :187, :286 | both | `--text-muted` |
| `#94a3b8` | background (toggle-track fill) | 2 | :3294, :5402 | I | **NEEDS DECISION** — muted control-track fill; `--bg-sunken` or a control-specific token? |
| `#d4af37` (93 total; S43/I50) | text (gold emphasis) | 33 | :297, :868, :1194 | both | `--accent` (decorative-only labels e.g. WORKSPACE `:1194` may instead drop to `--text-secondary`) |
| `#d4af37` | background (solid pill / soft tint) | 17 | :1958, :2024, :2223 | both | `--accent` for solid interactive fills; soft chip tints ⇒ `--accent-soft` |
| `#d4af37` | border | 10 | :314, :856, :901 | S | `--border-strong` (prominent gold frames) |
| `#d4af37` | gradient stop | 18 | :209, :461, :1187 | both | **DELETE** (decorative brand gradient) |
| `#d4af37` | interactive `accent-color` | 4 | :2638, :2645, :3791 | I | `--accent` (radio/checkbox tint) |
| `#2d3748` (33 total; S10/I23) | text (dark body on light chrome) | 31 | :122, :440, :519 | both | `--text-primary` |
| `#2d3748` | background | 2 | :37 (tooltip), :1624 (dead `.chat-avatar`) | S | **NEEDS DECISION** — keep tooltip intentionally dark, or invert? `:1624` is in dead CSS (§C) |
| `#cbd5e1` (25 total; S5/I20) | text (sidebar nav / lease list) | 24 | :1203, :1250, :3864 | both | `--text-secondary` |
| `#cbd5e1` | border | 1 | :1702 | S | `--border` (hairline task-check frame) |
| `#475569` (38 total; S3/I35) | text (slate body/label) | 38 | :1583, :2673, :2693 | both | `--text-secondary` |
| `#64748b` (37 total; S3/I34) | text (muted slate; incl. 10 JS-injected) | 37 | :392, :1063, :2677 | both | `--text-muted` (10 JS-string uses e.g. :7932, :9065 need hand-edit) |
| `#4a5568` (20 total; S4/I16) | text (folder/label/breadcrumb) | 20 | :399, :1632, :2898 | both | `--text-secondary` |
| `#0d1117` (16 total; S5/I11) | text (dark ink on gold buttons) | 14 | :1959, :2025, :3528 | both | `--text-on-accent` (**NEEDS DECISION** if any land on a light bg ⇒ `--text-primary`) |
| `#0a1420` (1 total; I1) | text (dark ink on gold badge) | 1 | :2402 | I | `--text-on-accent` |
| `#14263a` (0 total) | — | 0 | none in `views/app.html` | — | Not present here. (Audit's `--bg-mid #14263a` lives in `views/signup-vertical.html:13`, not this file. Near-duplicate `#14253a` does occur, e.g. `:1272`, but is out of scope.) |
| `#0a1828` (6 total; S5/I1) | gradient stop (dark shell bg) | 3 | :1149, :1272, :2318 | S | **NEEDS DECISION** — collapse dark bg gradient to a flat `--bg-surface`/`--bg-page`? |
| `#0a1828` | text (dark ink on gold) | 2 | :214, :1242 | S | `--text-on-accent` |
| `#0a1828` | icon fill (SVG `stroke` on check) | 1 | :233 | S | `--text-on-accent` |
| `#1a5f3f` (17 total; S8/I9) | gradient stop | 17 | :461 (btn-primary), :1187 (active nav), :1415 (hero strip) | both | `--accent` for interactive gradients (btn-primary `:461`, active nav `:1187`, quick-tile bar `:1521`); **DELETE** for the decorative hero shimmer strip `:1415`. Note: `#1a5f3f` already equals `--accent`. |
| `#2d8659` (21 total; S13/I8) | gradient stop | 20 | :461, :1187, :1521 | both | `--accent-hover` (darker/mid interactive stop); **DELETE** for decorative strips (`:1415`) |
| `#2d8659` | background (solid) | 1 | :1122 | S | `--accent` |
| `#ff6b6b` (53 total; S29/I24) | gradient stop | 16 | :427, :503, :1615 | both | **DELETE** (retired coral) |
| `#ff6b6b` | border | 11 | :414, :496, :1599 | both | **DELETE**; active-state borders (task-toggle `:1599`, quick-prompt hover `:1635`) are **NEEDS DECISION** ⇒ promote to `--accent`? |
| `#ff6b6b` | text | 14 | :401, :501, :1669 | both | **DELETE**; active folder-btn text (`:401`, `:501`) **NEEDS DECISION** ⇒ `--accent`? |
| `#ff6b6b` | background | 3 | :418 (badge), :647 (chip), :2386 (mic) | both | **DELETE** (badges); mic-action fill `:2386` is a real action ⇒ **NEEDS DECISION** `--accent`? |
| `#ff6b6b` | interactive `accent-color` | 1 | :1601 | S | `--accent` (checkbox checked = selected state) |
| `#ff8e53` (16 total; S11/I5) | gradient stop | 16 | :427, :503, :1615 | both | **DELETE** (retired orange; companion to `#ff6b6b`) |

---

## Main mapping table — rgba families

Every distinct variant is enumerated per family (with grep-derived total counts). Because the token decision is driven by **role**, the mapping rows below are grouped by role and list the variants that play that role. Spacing variants (`rgba(212, 175, 55, …)` with spaces) are called out where they exist.

### rgba(255,255,255,*) — faint white overlays (88 total; 0 spaced-format variants)

Variant enumeration (occurrences): `0.04`×49, `0.08`×9, `0.20`×6, `0.05`×5, `0.06`×4, `0.03`×4, `0.2`×2, `0.035`×2, `0.02`×2, `0.9`×1, `0.55`×1, `0.35`×1, `0.25`×1, `0.18`×1.

| variants in this role | role | count | example `views/app.html:` | S / I | proposed token |
| --- | --- | --- | --- | --- | --- |
| `0.02,0.03,0.035,0.04,0.05,0.08` | background / faint fill | ~59 (49 of them `0.04`) | :2010, :2087, :3545 | both | `--bg-hover` (a faint white fill is invisible on light; demote to the hover tint) |
| `0.06,0.08` | border (hairline on dark) | 2 | :56, :108 | S | `--border` |
| `0.05,0.06,0.08,0.18,0.20,0.2` | shadow (inset white highlight) | ~14 | :158, :217, :1190, :2368 | S | **DELETE** (inset highlights only read on dark surfaces) |
| `0.9,0.55,0.35,0.25,0.2` | text (on dark) | 5 | :96 (0.9), :84 (0.55), :79 (0.35), :82 (0.25), :110 (0.2) | S | `0.9`⇒`--text-primary`, `0.55`⇒`--text-secondary`, `0.35`/`0.25`⇒`--text-muted`; `0.2` (`:110`, near-invisible) **NEEDS DECISION** ⇒ `--text-muted`? |

### rgba(212,175,55,*) — gold overlays (123 total; **18 in spaced format** `rgba(212, 175, 55, …)`)

Spaced-format variants observed (e.g. `views/app.html:703, :704, :719, :925, :1024`) coexist with unspaced ones and are **distinct strings** for find-and-replace. Unspaced enumeration (occurrences): `0.18`×14, `0.28`×13, `0.45`×9, `0.40`×8, `0.22`×7, `0.35`×6, `0.30`×5, `0.65`/`0.20`/`0.16`/`0.10`/`0.06`×4 each, `0.55`/`0.25`/`0.15`×3, `0.50`/`0.4`/`0.08`×2, `0.75`/`0.5`/`0.42`/`0.32`/`0.3`/`0.14`/`0.05`/`0`×1; spaced variants add `0.3`/`0.2`/`0.18`/`0.15`/`0.08`×2 and `0.6`/`0.55`/`0.5`/`0.4`/`0.32`/`0.28`/`0.10`/`0`×1.

| variants in this role | role | count | example `views/app.html:` | S / I | proposed token |
| --- | --- | --- | --- | --- | --- |
| `0.10,0.15,0.18,0.22,0.25,0.28,0.30,0.35,0.40,0.42,0.45,0.50,0.55,0.65` (+ spaced) | border | ~58 | :154, :305, :1150 | both | `--border-strong` |
| `0,0.18,0.20,0.30,0.32,0.40,0.45,0.50,0.55,0.65,0.75` (+ spaced) | shadow / glow | ~22 | :315, :463, :1241, :2318 | both | **DELETE** (decorative gold glow) |
| `0,0.05,0.16,0.22,0.30,0.40,0.55,0.65` | gradient stop | ~13 | :25, :225, :1293 | S | **DELETE** (decorative gradient) |
| `0.06,0.08,0.10,0.14,0.15,0.16,0.20,0.2,0.3` | background (gold tint fill) | ~18 | :876, :1212 (nav hover), :2160 | both | `--accent-soft` for interactive-adjacent tints (nav hover, code chip); decorative-only tints ⇒ **DELETE** — **NEEDS DECISION** per instance |
| `0.35` | filter `drop-shadow` glow | 2 | :1473, :1540 | S | **DELETE** (decorative) |
| `0.65` | text | 1 | :7114 | I | **NEEDS DECISION** — low-alpha gold text in JS-built markup; `--accent` or drop? |

### rgba(45,134,89,*) — forest-green glows/tints (17 total; 0 spaced-format)

Variant enumeration (occurrences): `0.18`×5, `0.10`×4, `0.14`×2, `0.50`/`0.45`/`0.4`/`0.22`/`0.16`/`0.15`×1.

| variants in this role | role | count | example `views/app.html:` | S / I | proposed token |
| --- | --- | --- | --- | --- | --- |
| `0.10,0.14,0.18,0.22` | gradient stop (green glow) | ~9 | :26, :225, :1284 | S | **DELETE** (decorative radial/linear glow) |
| `0.50` | shadow (green glow) | 1 | :2414 | S | **DELETE** |
| `0.45` | border | 1 | :1114 | S | **NEEDS DECISION** — green chip border ⇒ `--border-strong` or `--accent`? |
| `0.15,0.16,0.4` | JS-injected inline (dynamic tint) | 3 | :1533, :8467, :8468 | S+I | classify at hand-edit; :1533 is a `box-shadow` glow ⇒ DELETE; :8467-8468 are JS strings |

### rgba(10,20,32,*) — dark-navy overlays / surfaces (25 total; **1 spaced** `rgba(10, 20, 32, 0.45)` at :728)

Variant enumeration (occurrences): `0.55`×8, `0.60`×6, `0.45`×3, `0.97`×2, `0.80`×2, `0.8`/`0.75`/`0.65`×1 (+ spaced `0.45`×1).

| variants in this role | role | count | example `views/app.html:` | S / I | proposed token |
| --- | --- | --- | --- | --- | --- |
| `0.45,0.55,0.60,0.75,0.80` | background (dark inputs / panels) | ~19 | :304 (form input), :354 (mode-card), :2850 | both | `--bg-sunken` for recessed inputs; standalone panels ⇒ `--bg-surface` — split per element |
| `0.80,0.97` | gradient stop (dark modal/topbar bg) | 3 | :883, :1078, :1127 | S | **NEEDS DECISION** — collapse dark navy gradient to a flat `--bg-surface`? |

---

## A. AMBIGUOUS LITERALS (multi-role — blanket find-and-replace is UNSAFE)

Thirteen literals/families serve 2+ roles. A single-role literal (listed after) is safe to blanket-replace inside `views/app.html`; each of these is not.

| literal | roles (count) | why blanket-replace is unsafe |
| --- | --- | --- |
| `#f5e6d3` | text 137, background 1, gradient stop 2 | both a body-text color AND a decorative knob fill/gradient — one target token would wreck the others. |
| `#e2e8f0` | text 41, border 45, background 6 | both secondary text AND borders AND light fills — three different tokens. |
| `#94a3b8` | text 201, background 2 | both muted text AND a control-track fill. |
| `#d4af37` | text 33, background 17, border 10, gradient stop 18, accent-color 4 | five roles spanning `--accent`, `--border-strong`, `--accent-soft`, and DELETE — the single most dangerous literal to sweep. |
| `#2d3748` | text 31, background 2 | both dark body text AND a tooltip/avatar background. |
| `#cbd5e1` | text 24, border 1 | both nav text AND a hairline border. |
| `#0a1828` | gradient stop 3, text 2, icon fill 1 | both a dark shell background AND dark ink-on-gold text/icon. |
| `#2d8659` | gradient stop 20, background 1 | interactive gradient stop vs solid fill (both green, but `--accent-hover` vs `--accent`). |
| `#ff6b6b` | gradient stop 16, border 11, text 14, background 3, accent-color 1 | retired coral appears as every role; most DELETE, but active-state uses may become `--accent`. |
| `rgba(255,255,255,*)` | background, border, shadow, text | faint-white overlay is a fill, a divider, an inset highlight, AND text depending on alpha/property. |
| `rgba(212,175,55,*)` | border, shadow, gradient stop, background, filter, text | gold overlay spans `--border-strong`, `--accent-soft`, and DELETE. |
| `rgba(45,134,89,*)` | gradient stop, shadow, border | green overlay is mostly decorative glow (DELETE) but one border. |
| `rgba(10,20,32,*)` | background, gradient stop | dark surface fill vs dark gradient stop. |

**Single-role literals — safe to blanket-replace within `views/app.html`:** `#475569` (text→`--text-secondary`), `#64748b` (text→`--text-muted`), `#4a5568` (text→`--text-secondary`), `#0d1117` (text→`--text-on-accent`), `#0a1420` (text→`--text-on-accent`), `#1a5f3f` (gradient stop only), `#ff8e53` (gradient stop only). (`#14263a` is absent from this file.) Note even these carry inline occurrences (e.g. `#475569` is I35/S3), so a stylesheet-only swap still misses most of them — see §D.

---

## B. SHELL ELEMENTS

`!important` is noted per rule. Base body/card/tile rules carry **none**; every `!important` on the shell lives in the `#topbar`/`#sidebar` override cascade (`views/app.html:1126-1247`) plus one on `.card`.

| element | selector & CSS rule range | key color decls | `!important` (file:line) |
| --- | --- | --- | --- |
| body background | `body {` `views/app.html:19-31` (multi-layer gradient `:24-28`, `color:#e2e8f0` `:30`); `html{background:#0f1c2e}` `:32`; responsive `body{}` `:1776` | radial gold/green glows `:25-27` + navy linear `:28` | none on base body/html |
| `#sidebar` | base `views/app.html:35-45` (`background:#2d3748` `:37`, `color:white` `:38`, `box-shadow` `:42`); override `views/app.html:1148-1155` (bg gradient `:1149`, border-right `:1150`, box-shadow `:1151-1153`); child overrides `:1170-1250`; responsive `:1779-1788` | dark navy gradient + gold accents | on `#sidebar` rule: `:1149`, `:1150`, `:1153`. Child-rule `!important` (same shell): `:1171, :1174-1177, :1180-1183, :1187, :1190, :1194-1198, :1203-1207, :1212-1213, :1220-1222, :1240-1242, :1246-1247`. Base `:35-45`: none |
| `#topbar` | base `views/app.html:115-127` (`background:white` `:116`, `border-bottom:#e2e8f0` `:119`, `color:#2d3748` `:122`, box-shadow `:126`); override `views/app.html:1126-1133`; `#topbar-time` `:1134-1139`; `#topbar h2,>div` `:1140`; `#topbar button` `:1141-1146`; responsive `:1794, :1855` | base is LIGHT (white bar) then override slams to dark glass | `:1127, :1128, :1129, :1130, :1131, :1132` (main rule); `:1135, :1136, :1137` (`#topbar-time`); `:1140`. Base `:115-127`: none |
| `.card` | base `views/app.html:148-165` (border `:154`, box-shadow `:157-161`, `color:#e2e8f0` `:164`); `.card:hover` `:166-173`; override `.card{margin-bottom:64px}` `:1366`; responsive `.card{padding}` `:1802` | dark navy translucent gradient + gold 22% border | `:1366` only. Base `:148-165`: none |
| `.card-hero` | `views/app.html:1403-1407` (base: position/padding/overflow only — inherits `.card`); `::before` animated gold/green strip `:1408-1418`; `::after` radial glow `:1419-1428` | decorative gradient strip `:1415`, radial glow `:1426` | none |
| `.stat-tile` | `views/app.html:1431-1447` (bg gradient `:1432`, border `:1436`, box-shadow `:1440-1444`); `::before` `:1448-1458`; `:hover` `:1459-1467` | translucent navy gradient + gold border | none |
| `.quick-tile` | `views/app.html:1497-1513` (bg gradient `:1498`, border `:1502`, box-shadow `:1506-1510`); `::before` left gradient bar `:1514-1525`; `:hover` `:1526-1534` | translucent navy gradient + gold border + green/gold left bar | none |
| sign-out control | **No CSS rule/class exists.** It is an inline `<a href="/api/logout" style="…color:#94a3b8;…border:1px solid #e2e8f0;…">` at `views/app.html:2302`, with JS hover recoloring to `#e74c3c` via `onmouseover`/`onmouseout` on the same line. Closest named match: none — it is identified only by `href="/api/logout"`. |

---

## C. DEAD CSS

**Verification method.** For every class defined in the CSS regions (`views/app.html:17-2254` and `:8923-8925`), a word-boundary scan checked whether the class name appears anywhere OUTSIDE those regions (i.e. in markup or JS). Candidates were then re-checked for **dynamic construction** (template literals / string concatenation), which the word-boundary scan cannot see. That re-check reversed several false positives — proving the method: `.tag-*`/`.cat-*`/`.avatar-*` are LIVE, built as `tag-${c.type}` (`views/app.html:6683, :6724`), `cat-${t.category}` (`:6443`), `avatar-${c.type}` (`:6677, :6722`); `.plan-usage-status-*` is LIVE via `'plan-usage-status-' + status` (`:7786`). Only classes with zero markup/JS reference AND no dynamic construction are reported below.

**Audit-flagged legacy Command Center block — CONFIRMED DEAD.** The audit cited `views/app.html:1606-1635`; verified range and self-description at `views/app.html:1862-1863` ("leftover from an earlier design and remain unused").

| dead rules | line range | verification |
| --- | --- | --- |
| `.chat-msg`, `.chat-bubble`, `.chat-avatar` (+ `.user`/`.ai` modifiers) | `views/app.html:1605-1624` | every `chat-` token in the file is confined to `:1606-1624` (definitions only); no `class="chat-…"` in markup/JS. |
| `.action-chip` | `views/app.html:1625-1629` | bare `action-chip` occurs only at `:1625`; all other hits are the unrelated `.ai-action-chip*` family (live). |
| `.quick-prompt` | `views/app.html:1630-1635` | bare `quick-prompt` occurs only at `:1630`/`:1635`; the live control is `.cc-quick-prompt` (`:1923, :12537`); the `:12698` hit is a JS comment. |

**Additional verified-unreferenced rules** (defined in CSS, zero markup/JS reference, no dynamic construction found):

| dead rule(s) | line(s) | verification |
| --- | --- | --- |
| `.card-title`, `.card-subtitle` | `views/app.html:175`, `:184` | only other mention is a descriptive comment `:1255-1256`; live equivalents are `.card-head-title` / `.mode-card-title`. |
| `.page-hero-actions`, `.page-hero-btn` | `views/app.html:1372`, `:1379-1402` | class names appear only at their own definitions/`:hover`; no `class="page-hero-…"` in markup/JS. |
| `.cal-event` | `views/app.html:502` (+ responsive `:1828`) | both references are CSS; the live calendar renders event dots via inline styles (e.g. `:5348`), never `class="cal-event"`. |

(Conservative caveat: "dead" here means no reference found via word-boundary + the standard template/concatenation patterns; a class assembled by some other runtime string would be missed, though none was observed.)

---

## D. BLAST RADIUS

**Inline attribute count — verified.** `grep -o 'style="'` returns **1,297** (`style='` single-quote form: 0), matching the audit exactly.

**Color vs layout split of those 1,297 inline attributes** (each `style="[^"]*"` extracted and tested):

| bucket | count | grep logic |
| --- | --- | --- |
| contain a hex literal (`#[0-9a-f]{3,8}`) | 695 | regex `#[0-9a-fA-F]{3,8}\b` |
| contain `rgb`/`rgba(` | 112 | regex `rgba?\(` |
| contain a named color (white/black/gold/…) | 28 (6 named-only) | word-boundary name list |
| contain `transparent` | 19 | `\btransparent\b` |
| **contain ANY color literal (hex OR rgba OR named)** | **727 (56.1%)** | union of the above |
| **layout-only (no color literal)** | **570 (43.9%)** | complement |
| of all inline attrs, JS-generated (`${…}`) | 45 | `\$\{` |

**`<style>`-block vs. everywhere-else split of ALL color literals** (hex + rgba occurrences across the file = **1,964**):

| region | color-literal occurrences | share |
| --- | --- | --- |
| primary `<style>` block (`views/app.html:17-2254`) — fixable centrally | 585 | 30% |
| outside it (markup + inline attrs + JS strings) — must be hand-edited | 1,379 | 70% |

Takeaway: a stylesheet/token swap reaches only ~30% of the color literals. The other ~70% (including 727 color-bearing inline `style="…"` attributes and 45 JS-generated style strings) sit in attributes and JS the swap cannot touch. Per-literal this is stark — e.g. `#94a3b8` is 191 inline vs 32 in-block, `#475569` is 35 inline vs 3 in-block, `#f5e6d3` is 102 inline vs 43 in-block.

---

## E. RECOMMENDED SEQUENCE

Ship the inversion as **several scoped commits, not one**. The evidence:

1. **The work does not live where a single swap can reach it.** Only 585 of 1,964 color occurrences are in the `<style>` block; 1,379 are inline/JS (§D). A "flip the tokens" commit would visibly fix ~30% and leave 727 inline color attributes (§D) still dark — a half-inverted live app. One giant commit therefore cannot be atomic anyway, so grouping by safety is the better trade.

2. **Sequence the mechanical-safe literals first, isolated.** The 7 single-role literals (§A: `#475569`, `#64748b`, `#4a5568`, `#0d1117`, `#0a1420`, `#1a5f3f`, `#ff8e53`) are the only ones a scripted find-and-replace can touch without per-site judgment. Land them as one reviewable commit (still must cover inline occurrences, e.g. `#475569` is I35/S3).

3. **Quarantine the ambiguous literals into their own commits, one family at a time.** The 13 multi-role literals/families (§A) — above all `#d4af37` (5 roles) and `#ff6b6b` (5 roles) and the four rgba families — must be edited per-occurrence, not swept. Group by literal so each diff is auditable and revertable.

4. **Isolate the shell (§B) as its own high-visibility commit.** body/`#sidebar`/`#topbar`/`.card`/tiles are what every screen shows first, and they are the densest `!important` cascade in the file (`views/app.html:1126-1247`). The base `#topbar` is already light (`background:white`, `:116`) but is overridden to dark glass with six `!important` (`:1127-1132`); inverting means removing overrides, not just recoloring — high blast-radius, worth its own reviewable, revertable change. `.card`/`.card-hero`/`.stat-tile`/`.quick-tile` share a translucent-navy gradient + gold-border + gold-glow-shadow pattern and can move together.

5. **Fold DELETE work (gold/coral glows, gradient stops, inset white highlights) into the relevant commit rather than a separate pass** — they are decorative and removing them alongside their element avoids a transient "flat, then re-styled" flash on the live site.

6. **Rollback safety on an auto-deploying site argues for the same split.** Small, single-concern commits mean a regression (e.g. ivory `#f5e6d3` text going `--text-primary` on a surface that stayed dark, or an active-state coral border silently deleted) can be reverted without unwinding the whole inversion. Suggested order, each independently deployable/revertable: (a) add the light-theme token layer with no behavioral change; (b) single-role literals (§A safe list); (c) shell elements (§B) including removing the `#topbar`/`#sidebar` `!important` overrides; (d) ambiguous literals one family at a time (`#e2e8f0`, `#94a3b8`, `#2d3748`, `#cbd5e1`, `#0a1828`, `#2d8659`, then `#d4af37`, `#ff6b6b`/`#ff8e53`, then the four rgba families); (e) a final sweep of the 727 color-bearing inline attributes and 45 JS style strings (§D), which no earlier commit could reach. Delete dead CSS (§C) at any point — it is inert and cannot regress anything.</content>
