# Modern Management — Design Audit (2026-07-17)

Read-only inventory of the CSS, HTML, and inline styles in the audited files. Every claim cites file:line. No recommendations, no proposed solutions.

Files audited:
- `views/app.html` (13,446 lines)
- `views/signup.html` (770), `views/signup-vertical.html` (155), `views/signup-success.html` (208), `views/signup-canceled.html` (90)
- `public/index.html` (444), `public/landing.html` (762), `public/login.html` (234), `public/signup.html` (274), `public/professional-services.html` (592)
- `public/css/features.css` (545)
- All 10 files in `public/features/*.html`: `ai.html` (328), `broadcasts-and-contacts.html` (280), `budget.html` (262), `calendar.html` (261), `inbox.html` (282), `knowledge-base.html` (433), `maintenance.html` (278), `rent-and-leases.html` (313), `reports.html` (249), `tasks.html` (218).

---

## 1. Screen Inventory

Screens inside `views/app.html`. Each is a top-level `<div class="page" id="page-*">` block; `page-home` contains two sibling `.page-content` panes (PM and PS) toggled by JS.

| Screen ID | Location | One-sentence purpose |
| --- | --- | --- |
| `page-home` (PM sub-pane `#page-home-pm`) | `views/app.html:2312-2478` | Home dashboard with hero banner, stat tiles, AI Command bar, snapshot report, lease expirations, and quick-access tile grid. |
| `page-home` (PS sub-pane `#page-home-ps`) | `views/app.html:2483-2555` | Mobile-first PS home dashboard with greeting, four-stat strip, and cards for appointments, AI conversations, approvals, transactions, low-stock. |
| `page-inbox` | `views/app.html:2559-2610` | Three-column resident inbox — folder buttons, message list, message detail. |
| `page-operations` | `views/app.html:2613-2779` | Automation-mode selector, connected-email walkthrough, and knowledge-base upload/form. |
| `page-calendar` | `views/app.html:2782-2821` | Month/year calendar grid with month/year `<select>`s, Today/Year toggles, plus a day-detail sidebar. |
| `page-reports` | `views/app.html:2824-2866` | Filterable list of AI-generated saved reports with a New Report CTA. |
| `page-contacts` | `views/app.html:2870-2939` | Search + type-filter contacts grid, contact detail side pane, CSV import/broadcast controls, broadcast history card. |
| `page-inventory` | `views/app.html:2942-3004` | PM property/unit inventory list with breadcrumb, list/detail/edit action strips, and empty-state. |
| `page-tasks` | `views/app.html:3007-3117` | Task summary chips, AI-suggested-tasks banner, all-tasks card with filter chips, sidebar add-task form and "Due this week" card. |
| `page-maintenance` | `views/app.html:3120-3157` | Emergency banner, summary chips, status `<select>` filter, and vertical ticket list. |
| `page-admin` | `views/app.html:3160-3499` | Notification settings, phone/email routing pills, plan & usage card, payment auto-match, rent-payments table, invoice/budget cards. |
| `page-finances` | `views/app.html:3501-3641` | Finances hub with Card Payments (PS), Transactions, Invoices, Budget, Rent Payments summary cards. |
| `page-my-business` | `views/app.html:3656-3899` | PS onboarding-style page — business description/hours/policies textareas, services/products spreadsheet tables, assistant settings, growth links. |
| `page-menu` | `views/app.html:3901-3930` | PS Services & Products menu with three tabs (Services / Products / Add-ons), search, list. |
| `page-inventory-ps` | `views/app.html:3936-3985` | PS Inventory & Vendors card with two tabs (Inventory / Vendors), status filter, list. |

---

## 2. Color Inventory

Colors were extracted with the regex `#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)` across the audited files and filtered to exclude HTML entities (`&#NNNNN;`). Named colors (`white`, `transparent`, etc.) are reported separately at the end. Values are normalized to lowercase; `rgba()` is kept as-authored (some inputs have spaces after commas, some don't — near-duplicates are shown as they appear).

**Total unique color literals identified: 414 hex/rgba values + 6 named-color usages = 420 total distinct color tokens.**

The following table is grouped and sorted by frequency. Where a single color plays multiple roles, up to three citations are shown.

### 2a. Top hex colors (>= 20 occurrences)

| Literal | Count | Role(s) | Representative citation(s) |
| --- | --- | --- | --- |
| `#94a3b8` | 249 | Muted grey — "Tier 4" body/muted text, hints, placeholders, borders | `views/app.html:132`, `views/app.html:187`, `public/index.html:151` |
| `#f5e6d3` | 173 | Ivory — "Tier 1" primary heading/text on dark surfaces | `views/app.html:179`, `views/app.html:244`, `public/index.html:46` |
| `#e2e8f0` | 129 | Light grey — "Tier 3" body text on dark; also border/input frame on light | `views/app.html:30`, `views/app.html:119`, `views/app.html:433` |
| `#d4af37` | 126 | Gold accent — buttons, borders, focus, links, icons, chip text | `views/app.html:209`, `public/index.html:51`, `public/professional-services.html:44` |
| `#ff6b6b` | 112 | Coral/red — legacy marketing accent, button gradient stop, active states | `views/app.html:65`, `public/css/features.css:25`, `public/landing.html:34` |
| `#ff8e53` | 88 | Orange — companion to `#ff6b6b` in gradients and marketing accents | `views/app.html:65`, `public/css/features.css:47`, `public/landing.html:73` |
| `#fca5a5` | 56 | Soft red — status text (`canceled`, `overdue`) | `views/app.html:968`, `public/css/features.css:359`, `views/app.html:1040` |
| `#e74c3c` | 49 | Danger red — `.btn-danger`, delete icons, error states | `views/app.html:402`, `views/app.html:474`, `views/app.html:1676` |
| `#475569` | 45 | Slate — button text, form labels, list-item text on light | `views/app.html:399`, `views/app.html:472`, `views/app.html:1583` |
| `#2d3748` | 45 | Deep charcoal — sidebar bg, topbar text, table body text | `views/app.html:37`, `views/app.html:122`, `views/app.html:1616` |
| `#64748b` | 38 | Muted slate — table headers, "excluded" text, feature-css muted | `views/app.html:392`, `views/app.html:1063`, `views/app.html:2677` |
| `#0d1117` | 34 | Deep navy — marketing/PS body background, button text on gold | `public/css/features.css:6`, `public/index.html:24`, `views/app.html:1959` |
| `#f1f5f9` | 31 | Cool light — chat AI bubble, "other" task cat, secondary btn | `views/app.html:388`, `views/app.html:472`, `views/app.html:607` |
| `#f8fafc` | 27 | Off-white — task hover, page background stops, forwarding card bg | `views/app.html:1589`, `views/app.html:1696`, `views/signup.html:12` |
| `#cbd5e1` | 25 | Light gray — sidebar nav text, task-check border | `views/app.html:1142`, `views/app.html:1203`, `views/app.html:1702` |
| `#86efac` | 24 | Mint — success text, `plan-badge-team`, save-confirm | `views/app.html:936`, `views/app.html:1011`, `views/app.html:3226` |
| `#27ae60` | 24 | Green — `.btn-success` gradient stop | `views/app.html:425`, `views/app.html:467`, `public/css/features.css:357` |
| `#2d8659` | 21 | Forest green — button gradient middle stop | `views/app.html:209`, `views/app.html:461`, `views/app.html:788` |
| `#dc2626` | 20 | Danger red — signup xmark, error modal, maint emergency banner | `views/app.html:3132`, `views/signup.html:41`, `views/signup-success.html:41` |
| `#667eea` | 20 | Indigo — legacy blob/avatar-vendor gradient stop | `views/app.html:1660`, `public/css/features.css:24`, `public/landing.html:35` |
| `#4a5568` | 20 | Slate-grey — folder button text, form-label, breadcrumb | `views/app.html:399`, `views/app.html:472`, `views/app.html:1757` |

### 2b. Mid-frequency hex (7-19)

| Literal | Count | Role(s) | Citation |
| --- | --- | --- | --- |
| `#1a5f3f` | 17 | Deep forest — btn-primary gradient start | `views/app.html:209`, `views/app.html:461`, `views/app.html:1187` |
| `#6ee7b7` | 15 | Mint text — `.tag-paid`, `.tag-green`, `.badge-*` | `public/css/features.css:357`, `public/css/features.css:362`, `views/app.html:1109` |
| `#dde3ec` | 12 | Border grey — modal inputs | `views/app.html:2855`, `views/app.html:12862`, `views/app.html:12867` |
| `#fff5f5` | 10 | Light pink — inbox `list-item.selected`, tag-resident bg | `views/app.html:413`, `views/app.html:497`, `views/app.html:1669` |
| `#e53e3e` | 10 | Danger red — required-field asterisk, archive/retire button color | `views/app.html:2964`, `views/signup.html:41`, `views/app.html:12973` |
| `#ccc` | 10 | Neutral gray shorthand — upload zone dashed border | `views/app.html:2759` |
| `#a5b4fc` | 10 | Indigo/lavender — legacy marketing chip | (found in feature pages via feature-card mock accents) |
| `#fff7ed` | 9 | Peach — `.cat-maintenance` bg, plan-card.selected bg | `views/app.html:1725`, `views/signup.html:75`, `views/signup-success.html:50` |
| `#ea580c` | 9 | Deep orange — task-cat `#cat-maintenance` text, AI-suggested icon | `views/app.html:1725`, `views/app.html:3025`, `views/app.html:3056` |
| `#1a2e4a` | 9 | Deep navy blue — modal label headings | `views/app.html:628`, `views/app.html:2676`, `views/app.html:2692` |
| `#16a34a` | 9 | Success green — signup `.step-dot.complete`, checkmarks | `views/signup.html:28`, `views/signup.html:50`, `views/signup-success.html:35` |
| `#f0fdf4` | 8 | Very-light green — `.cat-lease` bg | `views/app.html:1678`, `views/app.html:1726` |
| `#15803d` | 8 | Deep green — various success text (in feature pages) | `public/features/budget.html`, others |
| `#eef2ff` | 7 | Light indigo — code chip, gmail hint block bg | `views/app.html:636`, `views/app.html:2711`, `views/signup.html:12` |
| `#fffbeb` | 6 | Cream — `.lease-yellow` bg, `.ai-action-chip-warn` gradient stop | `views/app.html:667`, `views/app.html:1677` |
| `#fef2f2` | 6 | Pale red — signup invalid input bg, xmark bg | `views/signup.html:48`, `views/signup-success.html:41`, `views/signup.html:116` |
| `#fed7aa` | 6 | Peach border — phone-block border in signup-success | `views/signup-success.html:51`, `views/app.html:3023` |
| `#fecaca` | 6 | Light red — error-block border, signup-success | `views/signup-success.html:74`, `views/app.html`  |
| `#d97706` | 6 | Amber — `.lease-yellow` text | `views/app.html:1677` |
| `#aaa` | 6 | Neutral gray shorthand — inbox folder kicker | `views/app.html:2572` |
| `#0a1828` | 6 | Deep navy — background gradient stop | `views/app.html:1149`, `views/app.html:1272`, `views/app.html:2318` |

### 2c. Rest of the palette (2-6 occurrences)

Includes forest-glow tints, near-duplicate rgba variants, indigo/lavender, orange stops, cream, and mint tones. The full alphabetized list follows; each row that recurs elsewhere in the doc keeps its representative citation minimal (one).

| Literal | Count | Role | Citation |
| --- | --- | --- | --- |
| `#fdba74` | 5 | Warning orange text | `views/app.html:964`, `public/css/features.css:359` |
| `#fcd34d` | 5 | Yellow text | `public/css/features.css:358` |
| `#f59e0b` | 5 | Amber chip | `views/app.html:685` |
| `#f4f6f9` | 5 | Rent-table header background | `views/app.html:3387` |
| `#888` | 5 | Grey shorthand — inbox detail placeholder | `views/app.html:2606` |
| `#764ba2` | 5 | Legacy purple — `.avatar-vendor` gradient | `views/app.html:1660`, `public/css/features.css:26` |
| `#fef3f2` | 4 | Very pale red | seen in signup screens |
| `#fde68a` | 4 | Yellow border — `.ai-action-chip-warn` border | `views/app.html:668`, `views/app.html:1120` |
| `#fbbf24` | 4 | Amber — landing stat gradient stop | `public/landing.html`, `public/css/features.css:430` |
| `#f3ead8` | 4 | Cream text | `views/app.html:306` |
| `#bbf7d0` | 4 | Green pill | in signup/index (green tag bg) |
| `#a0aec0` | 4 | Grey — calendar header text | `views/app.html:484`, `views/app.html:543` |
| `#9a3412` | 4 | Deep amber — phone label text signup-success | `views/signup-success.html:55` |
| `#7c3aed` | 4 | Purple — `.cat-vendor` text | `views/app.html:1724` |
| `#4f46e5` | 4 | Indigo — code chip text, gmail link | `views/app.html:637`, `views/app.html:2714` |
| `#059669` | 4 | Emerald — `.cat-lease` text, `.lease-green` text | `views/app.html:1678`, `views/app.html:1726` |
| `#ffffff` | 3 | Explicit white (as opposed to keyword) | `views/app.html:788`, `public/index.html`, ... |
| `#fff9f9` | 3 | Near-white pink hover | `views/app.html:496`, `views/app.html:540` |
| `#fff` | 3 | White short-form | scattered |
| `#ffedd5` | 3 | Peach — signup-success phone-block gradient stop | `views/signup-success.html:50` |
| `#fef3c7` | 3 | Pale yellow | ai-action-chip-warn variant |
| `#fee2e2` | 3 | Pale red | signup-success xmark bg |
| `#f3e8ff` | 3 | Light purple | feature-card variant |
| `#e67e22` | 3 | Deep orange | `views/app.html:426` |
| `#dcfce7` | 3 | Pale green | `views/signup.html:95`, `views/signup-success.html:35` |
| `#c0392b` | 3 | Deep red | `.btn-danger` gradient stop `views/app.html:474`, `views/app.html:1626` |
| `#b91c1c` | 3 | Deeper red — emergency banner gradient stop | `views/app.html:3132` |
| `#4a90e2` | 3 | Blue — task-check hover, active-filter gradient | `views/app.html:1710`, `views/app.html:1732` |
| `#2ecc71` | 3 | Emerald — btn-success stop | `views/app.html:467` |
| `#1e293b` | 3 | Deep slate — code text on admin card | `views/app.html:3321` |
| `#14253a` | 3 | Deep navy — body gradient stop | `views/app.html:28`, `views/app.html:1272` |
| `#92400e` | 3 | Deep amber — chip-warn text | `views/app.html:670` |

Colors appearing **twice** (35+ additional): `#fff8f8`, `#fff0f0`, `#ff7675`, `#fed7d7`, `#fdf0f0`, `#f87171`, `#f5f5f5`, `#f39c12`, `#f0f4ff`, `#f0f0f0`, `#ef4444`, `#edf2f7`, `#ecfdf5`, `#e8f8f0`, `#e8edf4`, `#e8dcd2`, `#c2410c`, `#991b1b`, `#93c5fd`, `#7b5ea7`, `#6c63d4`, `#3b82f6`, `#166534`, `#161b22`, `#0f1c2e`, `#0f172a`, `#0a1422`, `#0a1420`. Representative citation for each: seen in `public/css/features.css`, `views/app.html:32`, `views/app.html:1732`, and the various signup/features files.

Colors appearing **once** (approximately 90 additional hex values): `#fffefb`, `#fffbf5`, `#ffcdd2`, `#ffbd2e`, `#ff5f56`, `#fdf0ff`, `#fafbfc`, `#fafafa`, `#f9f9f9`, `#f97316`, `#f8fffe`, `#f8dcdc`, `#f5f0ff`, `#f5576c`, `#f0fff4`, `#f0f4f8`, `#f0f2f5`, `#f0ecff`, `#f0b8b8`, `#f093fb`, `#eff6ff`, `#eef4ff`, `#eee`, `#ede9fe`, `#ecdbd4`, `#e9d5ff`, `#e8dec2`, `#e6edf3`, `#e1eaff`, `#e0f2fe`, `#ddd`, `#d4f0e3`, `#d4ece2`, `#d1fae5`, `#ccd3de`, `#c7d2fe`, `#c4b5fd`, `#c026d3`, `#b8caff`, `#b8941f`, `#b45309`, `#b2dfcb`, `#a7f3d0`, `#8ea3ff`, `#7f1d1d`, `#666`, `#3730a3`, `#334155`, `#27c93f`, `#2563eb`, `#1f2937`, `#1a7a45`, `#14263a`, `#10b981`, `#0f3a26`, `#0ea5e9`, `#0a1a28`, `#080f1e`, `#065f46`, `#061220`, `#0369a1`. Reference citations: `public/css/features.css:293`, `public/css/features.css:294`, `views/app.html:1601`, `views/app.html:2379`, `public/landing.html:34`, `views/signup-vertical.html:12`, and elsewhere.

### 2d. rgba() overlays

Most-used translucent overlays. Roles are dominated by three "brand" tints (gold `212,175,55`, coral `255,107,107`, white overlay) plus the navy background layers.

| Literal | Count | Role | Citation |
| --- | --- | --- | --- |
| `rgba(255,255,255,0.04)` | 81 | Card/tile default translucent surface on dark bg | `public/css/features.css:170`, `public/index.html:112`, `public/professional-services.html:137` |
| `rgba(148,163,184,0.25)` | 52 | Muted border for cards / inputs | `public/index.html:113`, `views/app.html:2545`, `views/app.html:3557` |
| `rgba(255,255,255,0.03)` | 49 | Slightly darker card surface | `public/css/features.css:372`, `public/index.html:188`, `public/features/*.html` |
| `rgba(255,255,255,0.06)` | 40 | Border/divider on dark | `public/css/features.css:35`, `public/index.html:40`, `views/app.html:1245` |
| `rgba(255,255,255,0.08)` | 38 | Sidebar dividers, card borders | `views/app.html:79`, `public/landing.html:47`, `public/css/features.css:194` |
| `rgba(255,255,255,0.4)` | 34 | Placeholder/foot-links text on dark | `public/landing.html:193`, `public/css/features.css:99` |
| `rgba(255,255,255,0.55)` | 24 | Sidebar nav text, hero-sub | `views/app.html:84`, `public/css/features.css:229`, `public/landing.html:63` |
| `rgba(255,255,255,0.7)` | 23 | Fallback muted text | `public/css/features.css:236` |
| `rgba(255,255,255,0.35)` | 17 | Sidebar nav subtitle, foot-links hover | `views/app.html:79`, `public/landing.html:194` |
| `rgba(0,0,0,0.4)` | 16 | Command Center shadow, hero-image shadow | `public/css/features.css:195`, `views/app.html:1880` |
| `rgba(255,255,255,0.5)` | 14 | Various muted body text | `public/landing.html:125` |
| `rgba(255,255,255,0.45)` | 14 | Section-sub, feature-card p | `public/landing.html:223`, `public/css/features.css:388` |
| `rgba(212,175,55,0.18)` | 14 | Faint gold border/divider | `views/app.html:1150`, `views/app.html:1171`, `views/app.html:1246` |
| `rgba(255,255,255,0.75)` | 13 | Big paragraph text | `public/css/features.css:236` |
| `rgba(255,107,107,0.3)` | 13 | Coral shadow — btn-primary shadow features | `public/css/features.css:51`, `public/css/features.css:164`, `public/signup.html:126` |
| `rgba(212,175,55,0.28)` | 13 | Gold border — form inputs | `views/app.html:277`, `views/app.html:305`, `views/app.html:322` |
| `rgba(255,255,255,0.25)` | 12 | Task-check border, misc muted | `views/app.html:1703`, `public/features/tasks.html` |
| `rgba(255,255,255,0.78)` | 11 | ai response, big paragraph | `public/css/features.css:322`, `public/css/features.css:447` |
| `rgba(148,163,184,0.18)` | 11 | Muted border | `public/index.html:189`, `public/professional-services.html:154` |

Additional rgba values used 3-10 times each (approximately 60 rows) span: `rgba(255,255,255,0.05)`, `rgba(255,255,255,0.10)`, `rgba(255,255,255,0.12)`, `rgba(255,255,255,0.20)`, `rgba(255,255,255,0.30)`, `rgba(255,255,255,0.55)`, `rgba(255,255,255,0.65)`, `rgba(255,255,255,0.85)`, `rgba(255,255,255,0.025)`, `rgba(255,255,255,0.035)`, `rgba(212,175,55,0.06/0.08/0.10/0.15/0.20/0.22/0.25/0.30/0.35/0.40/0.45/0.55/0.65)`, `rgba(45,134,89,0.10/0.14/0.15/0.16/0.18/0.22/0.40/0.45/0.50)`, `rgba(255,107,107,0.06/0.08/0.10/0.12/0.15/0.18/0.22/0.25/0.35/0.40/0.45/0.50/0.55/0.60/0.80)`, `rgba(255,142,83,0.06/0.10/0.15/0.20/0.22/0.85)`, `rgba(10,20,32,0.45/0.55/0.60/0.65/0.75/0.80/0.90/0.97)`, `rgba(20,38,58,0.5/0.6/0.7/0.8/0.97)`, `rgba(15,28,46,0.6/0.7/0.8)`, `rgba(13,17,23,0/0.5/0.6/0.85/0.98)`, `rgba(148,163,184,0.10/0.12/0.14/0.15/0.18/0.20/0.22/0.30/0.35/0.40/0.7)`, `rgba(231,76,60,0.05/0.06/0.08/0.10/0.15/0.20/0.25/0.30/0.35/0.40)`, `rgba(39,174,96,0.06/0.08/0.10/0.15/0.18/0.20/0.25/0.30/0.35/0.40)`, `rgba(102,126,234,0.06/0.08/0.10/0.25)`, `rgba(251,146,60,0.15/0.30/0.40)`, `rgba(251,191,36,0.06/0.15/0.20/0.30)`, `rgba(239,68,68,0.15/0.30/0.40)`, `rgba(34,197,94,0.15/0.40)`, `rgba(79,70,229,0.08/0.20)`, `rgba(26,95,63,0.08/0.22)`, `rgba(180,140,40,0.22)`, `rgba(110,231,183,0.18/0.60)`, `rgba(134,239,172,0.40)`, `rgba(165,180,252,0.60)`, `rgba(248,113,113,0.10/0.12/0.15/0.30/0.40)`, `rgba(252,165,165,0.60)`, `rgba(232,220,210,0.70)`, `rgba(248,247,243,0.70)`, `rgba(245,230,211,0.08/0.10/0.35)`, `rgba(234,88,12,0.15)`, `rgba(37,99,235,0.15)`, `rgba(124,58,237,0.15)`, `rgba(5,150,105,0.15/0.20)`, `rgba(217,119,6,0.20)`, `rgba(71,85,105,0.20)`, `rgba(40,20,10,0.06/0.10/0.14)`, `rgba(15,23,42,0.55)`, `rgba(8,15,30,0.55)`, `rgba(0,0,0,0.04/0.05/0.06/0.09/0.15/0.18/0.20/0.25/0.30/0.35/0.45/0.50/0.55/0.60)`. Representative anchors in `views/app.html:154-1500`, `public/landing.html:280-360`, `public/css/features.css:118-511`.

One template placeholder was captured: `rgba(255,255,255, x)` at `views/app.html:9139` (a JS template literal used to interpolate opacity, not a CSS literal).

### 2e. CSS named colors

| Keyword | Count | Role | Citation |
| --- | --- | --- | --- |
| `white` | 145 | Text on dark surfaces, modal bodies, button text | `views/app.html:38`, `views/app.html:116`, `views/app.html:398`, `public/login.html:98`, `public/css/features.css:135` |
| `inherit` | 58 | `color: inherit` / `font-family: inherit` — not a color value proper | `views/app.html:399`, `public/css/features.css:12`, `views/signup.html:37` |
| `transparent` | 57 | Border/background transparency | `views/app.html:170`, `views/app.html:390`, `views/app.html:1990` |
| `green` | 3 | Only in gradient / demo context | `views/app.html` demo strings |
| `red` | 2 | Only in error / demo context | `views/app.html` |
| `gray` | 1 | Single usage | `views/app.html` |

**TOTAL UNIQUE COLOR VALUES: 414 hex/rgba literals + 5 distinct CSS color keywords (white, transparent, green, red, gray) = 419 unique tokens.** (`inherit` is a keyword but not a color value; it is not counted.)

---

## 3. Typography Inventory

### 3a. Distinct `font-family` values (15 total)

| Family | Count | Citation |
| --- | --- | --- |
| `'Inter', sans-serif` | 20 | `views/app.html:20`, `views/app.html:309`, `views/signup-vertical.html:25` |
| `inherit` | 43 | `views/app.html:399`, `views/app.html:521`, `public/index.html:29` |
| `'Fraunces', serif` | 10 | `views/app.html:176`, `views/app.html:241`, `views/app.html:892` |
| `'Inter', sans-serif !important` | 6 | `views/app.html:825`, `views/app.html:863`, `views/app.html:1195` |
| `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif` | 3 | `views/signup.html:11`, `views/signup-canceled.html:11`, `views/signup-success.html:11` |
| `'Inter', -apple-system, BlinkMacSystemFont, sans-serif` | 3 | `public/css/features.css:5`, `public/index.html:23`, `public/professional-services.html:17` |
| `'Playfair Display', serif !important` | 2 | `views/app.html:784`, `views/app.html:1355` |
| `'Playfair Display', serif` | 2 | `views/app.html:1302`, `views/app.html:1476` |
| `'Fraunces',serif` (no space) | 2 | `views/app.html:8924`, other inline |
| `ui-monospace, 'SF Mono', Menlo, monospace` | 1 | `views/signup-canceled.html:30` |
| `Arial, sans-serif` | 1 | `views/app.html:1603` |
| `'SFMono-Regular', Consolas, monospace` | 1 | `views/app.html:640` |
| `'Fraunces', serif !important` | 1 | `views/app.html:1174` |
| `'Courier New',monospace` | 1 | `views/app.html:8924` context |

Two Google Fonts loads exist (`views/app.html:16`; `public/index.html:11`; `public/landing.html:14`; `views/signup-vertical.html:9`; `public/professional-services.html:11`), pulling in Inter (multiple weights), Playfair Display, and Fraunces.

### 3b. Distinct `font-size` values

**Unique size count: 121.**

By usage (top 30 shown; long tail continues):

| Size | Count | Notes |
| --- | --- | --- |
| `0.78em` | 133 | Most common — small labels, hints |
| `0.88em` | 110 | Body text |
| `0.92em` | 100 | Body text |
| `0.82em` | 97 | Sub-copy, hints |
| `0.85em` | 93 | Body text |
| `0.9em` | 58 | Body text |
| `0.8em` | 49 | Small labels |
| `0.7em` | 36 | Pill / badge text |
| `0.95em` | 28 | Body / inputs |
| `0.75em` | 24 | Chip text |
| `0.74em` | 24 | Chip text |
| `1em` | 22 | Reset baseline |
| `0.72em` | 22 | Kicker text |
| `0.76em` | 21 | Kicker text |
| `0.86em` | 20 | Body |
| `1.4em` | 17 | Card/hero title |
| `1.05em` | 17 | Body |
| `1.1em` | 14 | Section headings |
| `0.94em` | 12 | Body |
| `0.83em` | 11 | Labels |
| `0.84em` | 9 | Labels |
| `14px` | 8 | Fixed labels — `views/app.html:281`, `views/app.html:338`, `views/app.html:956` |
| `1.5em` | 8 | Icons |
| `1.3em` | 8 | Modal titles |
| `1.15em` | 7 | Sub-heads |
| `0.97em` | 7 | Body |
| `1.8em` | 6 | Page titles |
| `1.6em` | 6 | Sub-heads |
| `1.02em` | 6 | Body |
| `0.87em` | 6 | Body |

Long tail (values used 1-5 times): 91 additional distinct sizes including `13px`, `12px`, `11px`, `10px`, `15px`, `16px`, `18px`, `20px`, `22px`, `36px`, `1.55em`, `1.7em`, `1.85em`, `2.1em`, `2.2em`, `2.4em`, `2.5em`, `2.6em`, `2.7em`, `2.8em`, `3em`, `3.6em`, five `clamp(...)` responsive sizes (e.g. `clamp(1.8em, 3.5vw, 2.4em)` × 3 in `public/index.html:172` / `public/landing.html:214` / `public/professional-services.html:122`), plus `0.62em`, `0.65em`, `0.66em`, `0.68em`, `0.77em`, `0.91em`, `0.98em`, `1.08em`, `1.13em`, `1.18em`, `1.22em`, `1.25em`, `0.28em`, `0.34em`, `0.45em`, `0.55em`, and `!important` variants of many of the above.

### 3c. Distinct `font-weight` values (19)

| Weight | Count | Notes |
| --- | --- | --- |
| `600` | 227 | Semibold — most common |
| `700` | 181 | Bold — headings, buttons |
| `500` | 47 | Medium — body |
| `800` | 41 | Extrabold — hero titles, landing |
| `400` | 17 | Regular |
| `bold` (keyword) | 6 | Mixed with numeric — `views/app.html:484`, `views/app.html:2758`, `views/app.html:2766` |
| `900` | 2 | Landing hero — `public/landing.html:111`, `public/landing.html:317` |
| `600 !important` | 3 | |
| `700 !important` | 2 | |
| `400 !important` | 2 | |
| `800 !important` | 1 | |
| `500 !important` | 1 | |
| JS template `${msg.status==='new'?'700':'500'}` | 1 | `views/app.html:9139` conditional weight inside JS-generated markup |

### 3d. Text smaller than 14px

Sizes below the 14px threshold appear at these locations (all citing `views/app.html` unless noted):

- `.form-block-label` — **11px** (`views/app.html:294`) — kicker/eyebrow label
- `.plan-badge` — **11px** (`views/app.html:917`) — trial/solo/team/enterprise badge
- `.plan-usage-stat-label` — **11px** (`views/app.html:1028`) — usage stats label
- `#pushStatus` — inline **0.8em** (`views/app.html:3212`)
- `#workspaceSettingsRow` copy — **11px** ~ inline (`views/app.html:3228`)
- Emergency phone kicker/help — **0.78em** on `views/signup-success.html:55`, `views/signup-success.html:63`
- `.field-error` / `.field-success` / `.field-hint` — **0.78em** (`views/signup.html:49-51`)
- `.debug-block` — **0.82em** (`views/signup-canceled.html:31`)
- `.b5-ai-banner-chip` — **0.8em** (`views/app.html:725`)
- `.cc-tool-summary` — **0.74em** (`views/app.html:1975`)
- `.plan-price .period` — **0.28em** (`public/landing.html:319`) and **0.34em** (`public/professional-services.html:261`)
- `.plan-price .dollar` — **0.45em** (`public/landing.html:318`)
- `.stat-num .unit` — **0.55em** (`public/landing.html:193`)
- `.copilot-label` — **0.66em** (`public/landing.html:283`)
- `.foot-logo .badge` — **0.78em** (`public/css/features.css:536`)
- `.cal-mini-dow` — **0.62em** (`views/app.html:543`)
- `#sidebar > div:first-child > div:nth-child(2) > div:nth-child(2)` — **0.65em !important** (`views/app.html:1181`)
- `#sidebar .nav-label` — **0.62em** (`views/app.html:82`)
- `.contact-type-tag` — **0.68em** (`views/app.html:1666`)
- `.lease-badge` — **0.68em** (`views/app.html:1673`)
- Multiple inline `0.78em` labels throughout `page-admin`, `page-my-business`, `page-finances`, e.g. `views/app.html:3319`, `views/app.html:3556`, `views/app.html:3674`

Also present: many `0.7em` / `0.72em` / `0.74em` / `0.75em` / `0.76em` / `0.77em` pill/badge/eyebrow sizes (see 3b for counts).

### 3e. Contrast concerns (values-based observation only)

Conservative list of pairings that look weak from the code alone:

- `#messageDetail` placeholder text set to `color:#888` on a dark navy card body — `views/app.html:2606` (grey text sits on `card` gradient `rgba(20,38,58,0.60)` → very low contrast).
- Upload zone: `color:#888` on the dark-navy card — `views/app.html:2759`.
- `.plan-usage-price` (`#94a3b8` on `rgba(20,38,58,0.60)`) — `views/app.html:1004` on the plan-usage card; muted grey on translucent navy card.
- `.subscription-banner-past-due` uses `color:#fdba74` on `rgba(251,146,60,0.15)` — `views/app.html:964` — orange text on faint orange tint.
- `.subscription-banner-canceled` uses `color:#fca5a5` on `rgba(239,68,68,0.15)` — `views/app.html:968` — soft red on faint red tint.
- `.rentTable thead tr background:#f4f6f9` with `text-align:left` on the dark-mode `page-admin` — `views/app.html:3387` (light-mode header inside a dark card).
- Sign-out link `color:#94a3b8` with `border:1px solid #e2e8f0` sits on the dark-navy top bar (`views/app.html:2302`) — muted grey on dark navy with a near-white border stroke.
- `.debug-block .key` `color:#94a3b8` on `#f8fafc` background — `views/signup-canceled.html:34` (already light grey on very light background).
- `input::placeholder` in signup/login: `color: rgba(255,255,255,0.2)` on a translucent-white card — `public/login.html:110`, `public/signup.html:106`, `public/index.html`.
- `.hero-note` text `color: rgba(255,255,255,0.25)` — `public/landing.html:155` (very faint on dark navy).
- `.plan-price .period` at 0.28em with `rgba(255,255,255,0.35)` — `public/landing.html:319` (tiny + faint together).
- `.cc-input::placeholder` `color:#94a3b8` on `rgba(255,255,255,0.05)` translucent black — `views/app.html:2021`.
- `.approval-msg.customer` `color:#e2e8f0` with `border-left:3px solid #94a3b8` on `rgba(13,17,23,0.6)` — `public/professional-services.html:198` (OK contrast, but the muted grey left rail is nearly invisible against dark).
- Inbox `.list-item.selected` background `#fff5f5` (light pink) with default dark text — `views/app.html:414` — light-mode surface inside the dark app.
- `.tag-vendor` `color:#764ba2` on `#f0ecff` — `views/app.html:1670` — purple on faint lavender, borderline.
- `.tag-important` `color:#c026d3` on `#fdf0ff` — `views/app.html:1671` — pink-magenta on faint pink.
- `.contact-name` uses `color:#f5e6d3` (ivory) but `.contact-card` background is `white` — `views/app.html:1639` vs `views/app.html:1663` — ivory-on-white pairing.
- `.task-title` also `color:#f5e6d3` (ivory) inside light task-item — `views/app.html:1713` (list rows are light `background:#f8fafc` on hover, `views/app.html:1696`).

---

## 4. Spacing Inventory

### 4a. `padding` values (224 unique values)

Top 40 shown; the rest form a long tail of ad-hoc combinations.

| Value | Count |
| --- | --- |
| `8px 10px` | 40 |
| `9px 12px` | 39 |
| `12px 14px` | 38 |
| `10px 12px` | 34 |
| `14px` | 21 |
| `20px` | 17 |
| `10px 0` | 17 |
| `7px 10px` | 16 |
| `4px 10px` | 16 |
| `14px 16px` | 16 |
| `9px 14px` | 14 |
| `9px 10px` | 13 |
| `6px 0` | 13 |
| `10px 14px` | 13 |
| `10px 10px` | 12 |
| `16px` | 11 |
| `2px 8px` | 10 |
| `8px 12px` | 9 |
| `6px 14px` | 9 |
| `32px` | 9 |
| `0` | 9 |
| `7px 14px` | 8 |
| `5px 12px` | 8 |
| `9px 18px` | 7 |
| `6px 10px` | 7 |
| `12px 16px` | 7 |
| `12px` | 7 |
| `10px 16px` | 7 |
| `10px` | 7 |
| `9px` | 6 |
| `8px 14px` | 6 |
| `4px 8px` | 6 |
| `3px 10px` | 6 |
| `28px 32px` | 6 |
| `12px 22px` | 6 |
| `10px 22px` | 6 |
| `40px 20px` | 5 |
| `3px 5px` | 5 |
| `3px 0` | 5 |
| `16px 18px` | 5 |
| `11px 14px` | 5 |

Additional distinct values include `60px 20px`, `4px`, `30px`, `2px 9px`, `2px 7px`, `22px`, `14px 28px`, `14px 20px`, `14px 18px`, `13px`, `90px 32px`, `6px 12px`, `5px 0`, `4px 6px`, `40px 16px`, `28px`, `24px`, `22px 24px`, `20px 24px`, `20px 0`, `1px 7px`, `12px 0 16px`, and many one-off compounds down to `110px 32px 80px` (`public/professional-services.html`), `80px 0 60px` (`public/css/features.css:471`), `56px 40px 36px`, `5px 11px 5px 8px`, and `14px 44px 14px 18px` (`views/app.html:702`).

**Pattern observation:** the padding values do NOT follow a single consistent scale. Both 8-step (`8/16/24/32`) and 2/3-step (`2px 8px`, `3px 5px`, `3px 10px`, `4px 6px`, `4px 8px`, `5px 12px`, `6px 10px`, `7px 10px`, `9px 12px`, `10px 12px`, `11px 14px`, `13px 16px`) increments appear, along with odd offsets like `13px`, `9px`, `11px`, `26px`, and non-integer-ratio pairs. Marketing files trend toward 4/8/16/24/32/40/56/60/80/90/100/110 for section padding; the app dashboard trends toward 4/6/8/10/12/14/16/18/20/22/24/28/32 for card interiors. There is no consistent 4-step or 8-step scale across both.

### 4b. `margin` values (60 unique values)

| Value | Count |
| --- | --- |
| `0 auto` | 30 |
| `0` | 23 |
| `4px 0` | 7 |
| `0 8px` | 4 |
| `0 0 8px` | 4 |
| `0 0 14px` | 4 |
| `4px 0 0` | 3 |
| `16px 0` | 3 |
| `12px 0` | 3 |
| `0 auto 16px` | 3 |
| `0 0 4px` | 3 |
| `0 0 10px` | 3 |
| `40px 0` | 2 |
| `12px 0 8px` | 2 |
| `0 auto 40px` | 2 |
| `0 auto 36px` | 2 |
| `0 auto 28px` | 2 |
| `0 0 22px` | 2 |
| `80px 0 60px` | 1 |
| `6px 0 10px` | 1 |
| `60px 0 28px !important` | 1 |
| `5px 0 10px` | 1 |
| `56px auto 0` | 1 |
| `48px 0` | 1 |
| `3px 3px 3px 0` | 1 |
| `24px 0` | 1 |
| `22px 0` | 1 |
| `18px 0 8px` | 1 |
| `18px 0 22px` | 1 |
| `18px 0 14px` | 1 |
| `18px 0` | 1 |
| `14px 24px 18px` | 1 |
| `14px 0 6px` | 1 |
| `14px 0 4px` | 1 |
| `14px 0 10px` | 1 |
| `12px 16px 16px` | 1 |
| `10px 0` | 1 |
| `0 auto 60px` | 1 |
| `0 auto 50px` | 1 |
| `0 auto 32px` | 1 |
| `0 auto 24px` | 1 |
| `0 auto 20px` | 1 |
| `0 auto 18px` | 1 |
| `0 auto 12px` | 1 |
| `0 0 8px 0` | 1 |
| `0 0 4px 0` | 1 |
| `0 0 24px` | 1 |
| `0 0 18px` | 1 |
| `0 0 16px 0` | 1 |
| `0 0 12px` | 1 |
| `0 -10px` | 1 |
| `-6px 0 12px` | 1 |

**Pattern observation:** margin is dominated by `0 auto` (centering) and `0` (reset). Meaningful bottom-margins used include 4/6/8/10/12/14/16/18/20/22/24/28/32/36/40/48/50/56/60/80 — again, not a strict 4-step or 8-step scale; both odd (`6`, `10`, `14`, `18`, `22`, `50`) and even values are freely mixed. One negative margin (`-6px 0 12px`, `views/app.html:2722`) and one clearing negative (`0 -10px`) exist.

---

## 5. Component Inventory

This is the deepest section of the audit. Where "variant" is used, it means a visually distinct combination of border-color, background, padding, border-radius, font-size, and (where relevant) shadow. Adjacent variants that differ only in one hover-state color are combined here to keep the table scannable (noted parenthetically where done).

### 5a. Buttons

| # | Description | Example |
| --- | --- | --- |
| 1 | Global `button` reset — 10/18 pad, 10px radius, 0.87em, gold accent shadow | `views/app.html:448-459` |
| 2 | `.btn-primary` — green→gold gradient (`#1a5f3f→#2d8659→#d4af37`), ivory text | `views/app.html:460-465` |
| 3 | `.btn-success` — green gradient (`#27ae60→#2ecc71`), white text | `views/app.html:466-471` |
| 4 | `.btn-secondary` — flat `#f1f5f9` with `#e2e8f0` border, slate text | `views/app.html:472-473` |
| 5 | `.btn-danger` — red gradient (`#e74c3c→#c0392b`), white text | `views/app.html:474-475` |
| 6 | `.btn-primary` (features.css) — coral→orange gradient (`#ff6b6b→#ff8e53`), white text, 14/28 pad, 10px radius | `public/css/features.css:157-168` |
| 7 | `.btn-ghost` (features.css) — translucent white, thin border | `public/css/features.css:169-180` |
| 8 | `.btn-cta` (features nav) — coral gradient CTA in top nav | `public/css/features.css:56-64` |
| 9 | `.btn-nav-ghost` (index/professional-services) — `#94a3b8` text, no bg | `public/index.html:58-65`, `public/professional-services.html:41-42` |
| 10 | `.btn-nav-primary` (index/professional-services) — solid `#d4af37`, dark text | `public/index.html:66-76`, `public/professional-services.html:43-48` |
| 11 | `.btn-nav-ghost` (landing) — `rgba(255,255,255,0.55)` text, no bg | `public/landing.html:62-71` |
| 12 | `.btn-nav-primary` (landing) — coral gradient, box-shadow | `public/landing.html:72-83` |
| 13 | `.btn-hero-primary` (landing) — coral gradient, 15/36 pad, 1em, box-shadow | `public/landing.html:131-143` |
| 14 | `.btn-hero-ghost` (landing) — transparent, 1px border | `public/landing.html:144-154` |
| 15 | `.btn-plan-ghost` (landing) — translucent white, thin border | `public/landing.html:337-342` |
| 16 | `.btn-plan-primary` (landing) — coral gradient CTA | `public/landing.html:343-348` |
| 17 | `.btn-plan-outline` (landing) — transparent, muted white border | `public/landing.html:349-354` |
| 18 | `.btn-primary` (professional-services) — flat `#d4af37`, dark text, 14/28 pad | `public/professional-services.html:100-105` |
| 19 | `.btn-secondary` (professional-services) — outline gold, transparent bg | `public/professional-services.html:106-112` |
| 20 | `.approval-actions .approve` (professional-services) — flat gold | `public/professional-services.html:218` |
| 21 | `.approval-actions .edit` (professional-services) — outline ivory | `public/professional-services.html:219-222` |
| 22 | `.approval-actions .reject` (professional-services) — outline muted | `public/professional-services.html:223-226` |
| 23 | `.btn-plan` (professional-services) — flat gold block | `public/professional-services.html:282-289` |
| 24 | `.btn-plan-secondary` (professional-services) — outline gold block | `public/professional-services.html:290-299` |
| 25 | `.btn-login` (login) — coral gradient full-width | `public/login.html:112-129` |
| 26 | `.btn-signup` (signup) — coral gradient full-width | `public/signup.html:115-132` |
| 27 | `.btn-primary` (views/signup.html) — coral gradient, 12/22 pad, 0.94em, 8px radius | `views/signup.html:52-57` |
| 28 | `.btn-secondary` (views/signup.html) — outline white with slate text, 1.5px border | `views/signup.html:58-63` |
| 29 | Sidebar nav `<a>` — flex row, 11/14 pad, 10px radius, `.active` gets gold/forest gradient | `views/app.html:83-102`, `views/app.html:1216-1236` |
| 30 | `.page-hero-btn` — translucent-navy with 1px gold border, ivory text | `views/app.html:1379-1397` |
| 31 | `.folder-btn` — flat text button, 10/14 pad, 8px radius, coral active | `views/app.html:399-402` |
| 32 | `.cc-toggle` — round icon button, 36×36, muted border | `views/app.html:1989-2006` |
| 33 | `.cc-send` — gold pill, 22px radius, dark text | `views/app.html:2023-2036` |
| 34 | `.cc-quick-prompt` — gold-tinted rounded pill, 44px min-height | `views/app.html:1923-1938` |
| 35 | Menu-tab / inv-tab underline buttons — transparent bg, 2px gold underline when active | `views/app.html:3913-3915`, `views/app.html:3948-3949` |
| 36 | Rent-page inline `Refresh` / `Export CSV` / `New transaction` — different bg per action (gold tint, transparent w/muted border, solid gold) | `views/app.html:3547-3549` |
| 37 | Ad-hoc inline "Sign Out" pill — 5/12 pad, `#94a3b8` text, `#e2e8f0` border, JS-driven hover to red | `views/app.html:2302` |
| 38 | Ad-hoc inline "Save" gold button (my-business) — 10/22 pad, dark text on gold, 8px radius | `views/app.html:3697`, `views/app.html:3735`, `views/app.html:3770`, `views/app.html:3843`, `views/app.html:3893` |
| 39 | Ad-hoc inline "+ Add Service" ghost — 8/16 pad, transparent, muted border | `views/app.html:3733`, `views/app.html:3768` |
| 40 | Ad-hoc inline "Set up card payments" (Stripe) — 9/16 pad, flat gold, 8px radius | `views/app.html:3528` |
| 41 | `.ps-btn-approve` — 44px min-h, flat gold | `views/app.html:2222-2225` |
| 42 | `.ps-btn-reject` — 44px min-h, transparent with muted border | `views/app.html:2226-2230` |
| 43 | `.subscription-banner-cta` — 6/14 pad, gold tint bg, ivory text | `views/app.html:971-981` |
| 44 | `#micBtn` — 48×48 icon-only, cream bg (`#fffefb`) with `#e8dcd2` border, JS-driven state coral gradient | `views/app.html:2378-2381`, then overridden by CSS at `views/app.html:842-851` |
| 45 | Contact-type filter — inline `.btn-secondary` overloaded with `.active-filter` gaining blue/purple gradient | `views/app.html:2891-2897`, activation rule `views/app.html:1732` |
| 46 | Emergency banner icon-button (implicit — inside `#emergencyBanner`) — no bg, white text | `views/app.html:3132-3135` |

Additional inline buttons in `page-finances` filters, modal footers, and modal action rows push the total higher (approx. 50+ visually distinct button treatments across the codebase when hover states and layer overrides are counted).

### 5b. Text inputs (`<input type="text|email|password">`, `<textarea>`)

| # | Description | Example |
| --- | --- | --- |
| 1 | Global `textarea, input:not([type="checkbox"]), select` — 10/13 pad, 1.5px `#e2e8f0` border, 10px radius, `#fafbfc` bg, `#2d3748` text; focus coral border + coral shadow | `views/app.html:430-447` |
| 2 | `.form-block input` — dark-navy translucent bg (`rgba(10,20,32,0.55)!important`), 1px gold border, ivory text, 10/12 pad, 8px radius, 13px | `views/app.html:300-317` |
| 3 | `#homeCommandInput` — same dark-navy palette, 1.5px gold border, backdrop-blur | `views/app.html:820-836` |
| 4 | Inline dark-input pattern used across `page-finances`, `page-menu`, `page-inventory-ps`, `page-my-business` — `rgba(255,255,255,0.04)` bg, 1px `rgba(148,163,184,0.25)` border, 8px radius, ivory text, 0.88-0.92em | `views/app.html:3545`, `views/app.html:3677`, `views/app.html:3820`, `views/app.html:3873`, `views/app.html:3920`, `views/app.html:3956` |
| 5 | Modal inputs (contact/property/unit/tx) — 8/10 pad, 1px `#dde3ec` border, 7px radius, 0.9em | `views/app.html:2855`, `views/app.html:12855-12882` |
| 6 | `#connEmail` / `#connPass` — same as global reset (see #1), no explicit override | `views/app.html:2721`, `views/app.html:2724` |
| 7 | Custom IMAP/SMTP inline inputs — 0.85em, no other overrides | `views/app.html:2728-2731` |
| 8 | `public/login.html input[type="text|password"]` — 12/14 pad, `rgba(255,255,255,0.07)` bg, 1px translucent border, 9px radius, white text, 0.95em; focus coral border + shadow | `public/login.html:92-110` |
| 9 | `public/signup.html input[type="text|password|email"]` — identical shape to login (12/14 pad, 9px, 0.95em) | `public/signup.html:88-106` |
| 10 | `views/signup.html input, select` — 11/13 pad, 1.5px `#e2e8f0`, 8px radius, 0.95em, `#2d3748` text; `.invalid` uses `#e53e3e` border + `#fef2f2` bg | `views/signup.html:42-48` |
| 11 | `views/signup-success.html` username-block styled `<div>` (not an input) that resembles an input — `#f8fafc` bg, 1px `#e2e8f0`, 8px radius, 0.9em | `views/signup-success.html:66-70` |
| 12 | `views/signup-canceled.html debug-block` — monospace, `#f8fafc` bg | `views/signup-canceled.html:28-35` |

### 5c. Dropdowns (`<select>`)

| # | Description | Example |
| --- | --- | --- |
| 1 | Global (same as inputs #1 above) | `views/app.html:430-447` |
| 2 | `.cal-nav select` — 7/10 pad, 1px `#e2e8f0` border, 8px radius, `#2d3748` text, white bg | `views/app.html:514-524` |
| 3 | Reports type filter — 9/14 pad, `rgba(10,20,32,0.55)` bg, 1px gold border, ivory text | `views/app.html:2850` |
| 4 | Rent month/year selects — 7/10 pad, 1px `#e2e8f0` border, 8px radius, white bg, `#2d3748` text | `views/app.html:3365-3372` |
| 5 | Maintenance filter — 8/12 pad, 1px `#dde3ec` border, 8px radius, white bg | `views/app.html:3142` |
| 6 | PS transactions filter selects — 7/10 pad, `rgba(255,255,255,0.04)` bg, muted border, ivory text | `views/app.html:3568-3582` |
| 7 | My-Business Tone / Sales dropdown — 9/12 pad, dark translucent bg, muted border, ivory text | `views/app.html:3820`, `views/app.html:3832` |
| 8 | Menu-item modal Type select — 9/12 pad, dark translucent bg, muted border, ivory text | `views/app.html:3998` |
| 9 | Inventory status filter — same shape as #7 | `views/app.html:3958` |

### 5d. Modals / popups

There are approximately 24 distinct `.modal-overlay` blocks in `views/app.html`, plus separate modal treatments in `views/signup.html` and other files. Structural variants:

| # | Description | Example |
| --- | --- | --- |
| 1 | Base `.modal-overlay` — fixed, `rgba(8,15,30,0.55)` overlay, 3px backdrop-blur, z-index 1000 | `views/app.html:565-573` |
| 2 | Base `.modal` — white bg, 18px radius, 32px pad, 440px width | `views/app.html:574-582` |
| 3 | `.modal-content-dark` — dark navy gradient, gold 28% border, ivory text, 16px radius, 28/32 pad, 480px width | `views/app.html:1077-1086` |
| 4 | `#reportDetailModal .modal` — dark navy gradient, gold 28% border, ivory text | `views/app.html:879-889` |
| 5 | `#maintModal` inline `.modal` — inherits base white, 500px max-width | `views/app.html:12783-12784` |
| 6 | `#txModal` inline `.modal` — inherits base white, 460px max-width | `views/app.html:12848-12849` |
| 7 | `#contactModal` inline `.modal` — inherits base white, 480px width | `views/app.html:12892-12893` |
| 8 | `#propertyModal` inline `.modal` — inherits base white, 540px width | `views/app.html:12968-12969` |
| 9 | `#unitModal` inline `.modal` — inherits base white, 580px width | `views/app.html:13028-13029` |
| 10 | `#menuItemModal .modal` — dark, 560px, `#f5e6d3` heading | `views/app.html:3993-3994` |
| 11 | Onboarding `#onboardingModal .modal` — base white, 480px, centered | `views/app.html:12746` |
| 12 | Upgrade `#upgradePromptModal` — uses `.modal-content-dark` (see #3) | `views/app.html:12735` |
| 13 | Signup-form `.modal-overlay` (separate CSS) — `rgba(15,23,42,0.55)` overlay, no blur; `.modal-dialog` white bg, 14px radius, 28px pad, 440px | `views/signup.html:101-113` |
| 14 | Modal footer buttons pattern varies — flex-end (`views/app.html:1583-1584`) vs signup center (`views/signup.html:128-130`) |

### 5e. Tables

| # | Description | Example |
| --- | --- | --- |
| 1 | Rent table — plain HTML `<table>`, `#f4f6f9` (light) header row, 8/10 cell padding, 0.93em, min-width 520px | `views/app.html:3384-3397` |
| 2 | Services table (`#mbServicesTable`) — plain `<table>`, muted uppercase header, 8/10 pad, 0.9em, no borders | `views/app.html:3716-3728` |
| 3 | Products table (`#mbProductsTable`) — same style as Services minus the Duration column | `views/app.html:3752-3763` |
| 4 | CSS-grid pseudo-table `.calendar-grid` — 7-col grid, 4px gap | `views/app.html:478-483` |
| 5 | Card-based row list `.mock-row` (feature pages) — flex row, 10/0 pad, bottom-border | `public/css/features.css:338-348` |
| 6 | Task-item pseudo-rows `.task-item` — flex row, 14/10 pad, thin bottom-border | `views/app.html:1687-1729` |
| 7 | Rent inline `#rentTable` rows and `#maintTicketList` items use flex/grid layouts as pseudo-tables — see `views/app.html:3154`, `views/app.html:3396` |
| 8 | PS `.mock-row` inside marketing pages uses same visual language as #5 — `public/css/features.css:338`, reused across features files |

### 5f. Cards

| # | Description | Example |
| --- | --- | --- |
| 1 | `.card` — dark navy translucent gradient, 24px backdrop-blur, 18px radius, 1px gold 22% border, 28/32 pad, dark shadow, ivory text | `views/app.html:148-165` |
| 2 | `.card-hero` — same as `.card` plus 3px animated gradient top strip, 32/34 pad, corner glow | `views/app.html:1403-1428` |
| 3 | `.stat-tile` — smaller `.card`, 16px radius, 22/24 pad, hover lift + border tint | `views/app.html:1431-1494` |
| 4 | `.quick-tile` — like `.stat-tile` plus left-edge gradient bar | `views/app.html:1497-1554` |
| 5 | `.contact-card` — WHITE bg card (not dark), 14px radius, 1px `#e2e8f0` border, 20px pad, 0/2/8/0 shadow | `views/app.html:1638-1651` |
| 6 | `.lease-row` — flat WHITE row, 10/14 pad, 1px `#e2e8f0`, 10px radius | `views/app.html:1679-1683` |
| 7 | `.pricing-card` (landing) — dark card, 20px radius, 34/26/30 pad, 1px translucent border; `.featured` gets coral tint | `public/landing.html:270-300` |
| 8 | `.pricing-card` (professional-services) — dark card, 16px radius, 32/26 pad; `.featured` gets gold border + gold tint | `public/professional-services.html:233-243` |
| 9 | `.vertical-card` (index) — dark card, 16px radius, 36/32 pad, muted border, gold hover | `public/index.html:111-126` |
| 10 | `.vertical-card` (signup-vertical) — 160deg dark navy gradient, 16px radius, 32px pad, 1px gold border | `views/signup-vertical.html:58-74` |
| 11 | `.feature-card` (features.css) — subtle white overlay, 14px radius, 26/24 pad, hover translate | `public/css/features.css:371-378` |
| 12 | `.feature-card` (landing) — same shape but 16px radius, 28/26 pad | `public/landing.html:235-259` |
| 13 | `.who-card` (professional-services) — 12px radius, 20/14 pad, centered | `public/professional-services.html:136-142` |
| 14 | `.pill` (index different-section) — flex row, 14px radius, 22px pad | `public/index.html:235-243` |
| 15 | `.ps-dashboard-card` — 10px radius, 1px muted border, `rgba(255,255,255,0.035)` bg | `views/app.html:2111-2117` |
| 16 | `.ps-stat` — 10px radius, 80px min-height, 14px pad, 1px muted border | `views/app.html:2083-2094` |
| 17 | `.plan-usage-stat` mini-tile inside plan card — 8px radius, 12/14 pad, 1px 10%-gold border | `views/app.html:1021-1026` |
| 18 | `.routing-pill` — 10px radius, 14/16 pad, dark bg, gold 28% border | `views/app.html:320-328` |
| 19 | `.mode-card` — 10px radius, 16px pad, dark bg, gold 28% border | `views/app.html:353-363` |
| 20 | Signup card (`public/signup.html .signup-card`) — 18px radius, 44/40 pad, translucent white bg, backdrop-blur | `public/signup.html:44-55` |
| 21 | Login card (`public/login.html .login-card`) — 18px radius, 44/40 pad, translucent white bg | `public/login.html:48-59` |
| 22 | Onboarding modal cards, phone-block (`views/signup-success.html:49-53`) — cream gradient card with `#fed7aa` border | `views/signup-success.html:49-53` |
| 23 | Approval mock (`.approval-mock` professional-services) — translucent white, 14px radius, 22/24 pad | `public/professional-services.html:184-190` |
| 24 | Ad-hoc "forwarding info" box (Admin) — `#f8fafc` bg, 1px `#e2e8f0`, 10px radius, 14/16 pad | `views/app.html:3318-3327` |
| 25 | Ad-hoc emergency banner card — red gradient, 12px radius, 14/20 pad, white text | `views/app.html:3132` |
| 26 | Ad-hoc "AI Suggested Tasks" card — cream gradient with peach border, 1.5px `#fed7aa` border | `views/app.html:3023` |
| 27 | Callout `.callout` (features.css) — dual-tint gradient bg, 16px radius, 32/36 pad | `public/css/features.css:391-397` |
| 28 | `.final-cta` (features.css) — coral+indigo gradient, 20px radius, 60/50 pad | `public/css/features.css:465-472` |

(Cards #5, #6, #22, #24, #26 are LIGHT-theme surfaces embedded inside otherwise dark-theme parent pages.)

### 5g. Tabs / segmented controls

| # | Description | Example |
| --- | --- | --- |
| 1 | Sidebar nav — vertical column of `<a>` items, 11/14 pad, 10px radius, `.active` gets gold+forest gradient with 3px left-edge gold indicator | `views/app.html:83-102`, `views/app.html:1216-1236` |
| 2 | Inbox `.folder-btn` — flat button, 10/14 pad, 8px radius, coral tint when active | `views/app.html:398-402` |
| 3 | Contact type filter row — reuses `.btn-secondary` with `.active-filter` blue/purple gradient overlay | `views/app.html:2891-2897`, `views/app.html:1732` |
| 4 | Task filter row — same reuse pattern as #3 | `views/app.html:3052-3057` |
| 5 | Maintenance filter — `<select>` instead of segmented control | `views/app.html:3142` |
| 6 | PS `menu-tab` / `inv-tab` — 10/16 pad, 2px gold underline when active, transparent bg, ivory active text, `#94a3b8` inactive text | `views/app.html:3913-3915`, `views/app.html:3948-3949` |
| 7 | Marketing `.billing-toggle` (landing) — segmented control with translucent white bg, 10px radius, 4px pad, `.active` gets `rgba(255,255,255,0.1)` bg | `public/landing.html:356-382` |
| 8 | Signup `.billing-toggle` — segmented on `#f1f5f9`, 8px radius, white pill `.active` with tiny shadow | `views/signup.html:80-93` |
| 9 | Signup step indicator `.step-dot` — dot pill row, `.active` coral, `.complete` `#16a34a` | `views/signup.html:22-28` |
| 10 | Onboarding modal step dots `.ob-step-dot` — 8×8 dots, `.active` coral gradient expands to 24×8 pill | `views/app.html:1745-1746` |
| 11 | Signup-success `.state` toggle — `display:none/block` with no visible chrome | `views/signup-success.html:21-22` |
| 12 | Command Center `.cc-toggle` — round icon that flips 180° when panel is open | `views/app.html:1989-2006` |

### 5h. Toasts / alerts / status pills / badges

| # | Description | Example |
| --- | --- | --- |
| 1 | Sidebar counter pills (Tasks, Inbox, Maintenance) — inline red `#e74c3c` bg, white text, 20px radius, 1/7 pad, `badgePop` animation | `views/app.html:2274`, `views/app.html:2284`, `views/app.html:2289`; overridden to gold/forest at `views/app.html:1238-1243` |
| 2 | `.badge` — coral bg, white text, 20px radius, 2/9 pad; variants `.sent` (green), `.in-progress` (amber), `.new` (coral gradient) | `views/app.html:415-427` |
| 3 | `.contact-type-tag` — 0.68em uppercase, 2/8 pad, 20px radius; `.tag-resident` / `.tag-vendor` / `.tag-important` with distinct pastel bg + colored text | `views/app.html:1665-1671` |
| 4 | `.lease-badge` — 0.68em, 2/7 pad, 20px radius; `.lease-red`/`.lease-yellow`/`.lease-green` with distinct pastel + colored text + 1px border | `views/app.html:1672-1678` |
| 5 | `.task-cat` — 0.7em uppercase, 2/8 pad, 20px radius; `.cat-vendor/.cat-maintenance/.cat-lease/.cat-finance/.cat-other` each with own pastel/color | `views/app.html:1716-1728` |
| 6 | `.plan-badge` — 4/10 pad, 12px radius, uppercase Fraunces 11px; `.plan-badge-trial/.plan-badge-solo/.plan-badge-team/.plan-badge-enterprise` each with own bg/text/border tone | `views/app.html:912-944` |
| 7 | `.ps-badge` — 4/10 pad, 12px radius; `.ps-badge-paid/.ps-badge-pending/.ps-badge-attention/.ps-badge-muted` variants | `views/app.html:2195-2208` |
| 8 | `.hero-eyebrow` (landing) — inline-flex pill, coral tint, 5/16 pad, 20px radius, coral text | `public/landing.html:95-108` |
| 9 | `.eyebrow` (features.css) — coral tint pill, 30px radius, 7/18 pad | `public/css/features.css:117-128` |
| 10 | `.hero-eyebrow` (professional-services) — no bg, just gold uppercase text kicker | `public/professional-services.html:55-60` |
| 11 | `.mc-pill` (landing) — inline-flex pill, coral tint, 20px radius, 6/14 pad | `public/landing.html:157-170` |
| 12 | `.mock-tag` (features.css) — 3/10 pad, 20px radius, 0.7em uppercase; `.tag-paid/.tag-pending/.tag-overdue/.tag-red/.tag-yellow/.tag-green` each with own tint | `public/css/features.css:349-362` |
| 13 | `.savings-tag` (landing) — pale-green pill next to billing toggle | `public/landing.html:383-393` |
| 14 | `.savings-tag` (signup) — solid `#dcfce7` bg, `#16a34a` text — DIFFERENT shape from #13 | `views/signup.html:94-98` |
| 15 | `.plan-badge` inline `.plan-badge-label` in signup — coral tint, 20px radius, 4/12 pad, 0.75em | `public/signup.html:154-166` |
| 16 | `.copilot-label` (landing) — indigo tint pill, 10px radius, 3/10 pad, 0.66em | `public/landing.html:281-293` |
| 17 | `.popular-badge` (landing) — coral gradient pill, absolute-positioned above featured card | `public/landing.html:301-315` |
| 18 | `.popular-badge` (professional-services) — solid gold, 14px radius | `public/professional-services.html:244-251` |
| 19 | `.folder-count` — inline red pill on folder buttons | `views/app.html:402` |
| 20 | `.chip-check` inside `.ai-action-chip` — 16×16 circle, green bg, white check | `views/app.html:671-683` |
| 21 | `.ai-action-chip` — 8px radius, 5/11/5/8 pad, green tint bg, dark-green text; `.ai-action-chip-warn` yellow variant; overridden later at `views/app.html:1112-1124` to different (translucent-navy) treatment | `views/app.html:652-670` and `views/app.html:1112-1124` |
| 22 | `.b5-ai-banner` — gold-tint bg, gold border, 10px radius, 14/44/14/18 pad | `views/app.html:699-710` |
| 23 | `.b5-ai-banner-chip` — separate chip style, 6px radius, dark bg, muted text | `views/app.html:724-732` |
| 24 | `.subscription-banner-past-due/.subscription-banner-canceled` — sticky orange/red tinted banner | `views/app.html:961-970` |
| 25 | `#emergencyBanner` inline — red gradient bar with white text | `views/app.html:3132` |
| 26 | `#connectStatusBadge` inline — 6/12 pad, 999px radius, dynamic bg | `views/app.html:3527` |
| 27 | `#planUsageCardBadge` (reuses `.plan-badge`) — appears within Plan & Usage card | `views/app.html:3278` |
| 28 | Signup step-indicator dot vs. onboarding-modal step-dot — two separate systems | `views/signup.html:22-28` vs `views/app.html:1745-1746` |
| 29 | Signup `.error-msg` alert — 8px radius, red tint bg, 1px red border, `#ff7675` text | `public/login.html:131-140`, `public/signup.html:134-143` |
| 30 | Signup `.field-error` inline text — no chrome, just `#e53e3e` 0.78em text | `views/signup.html:49` |
| 31 | Modal error `.modal-icon` — 48×48 circle, `#fef2f2` bg, red text, centered | `views/signup.html:114-119` |
| 32 | Signup-success `.check` (green success circle 56×56) and `.xmark` (red failure circle 56×56) | `views/signup-success.html:33-44` |

---

## 6. Structure Notes

### 6a. `<style>` blocks and CSS in each file

| File | Style blocks | Approx. block-content lines | Inline `style="..."` attrs |
| --- | --- | --- | --- |
| `views/app.html` | 2 (lines 17-2254 primary; 8923-8925 tiny secondary) | Primary block ≈ 2,237 lines; secondary block 2 lines | 1,297 |
| `views/signup.html` | 1 (7-131) | 124 | 2 |
| `views/signup-vertical.html` | 1 (10-108) | 98 | 1 |
| `views/signup-success.html` | 1 (7-93) | 86 | 0 |
| `views/signup-canceled.html` | 1 (7-49) | 42 | 0 |
| `public/index.html` | 1 (12-321) | 309 | 7 |
| `public/landing.html` | 1 (15-475) | 460 | 26 |
| `public/login.html` | 1 (12-150) | 138 | 1 |
| `public/signup.html` | 1 (8-167) | 159 | 2 |
| `public/professional-services.html` | 1 (12-357) | 345 | 1 |
| `public/features/ai.html` | 1 (230-232) | 2 | 12 |
| `public/features/broadcasts-and-contacts.html` | 0 | 0 | 31 |
| `public/features/budget.html` | 0 | 0 | 52 |
| `public/features/calendar.html` | 0 | 0 | 44 |
| `public/features/inbox.html` | 0 | 0 | 32 |
| `public/features/knowledge-base.html` | 0 | 0 | 75 |
| `public/features/maintenance.html` | 0 | 0 | 37 |
| `public/features/rent-and-leases.html` | 0 | 0 | 36 |
| `public/features/reports.html` | 0 | 0 | 27 |
| `public/features/tasks.html` | 0 | 0 | 36 |

### 6b. External stylesheets referenced

- `public/css/features.css` — referenced by 16 marketing pages via `<link rel="stylesheet" href="/css/features.css" />` at line 9 of each of `public/changelog.html`, `public/how-it-works.html`, `public/privacy.html`, `public/security.html`, `public/terms.html`, `public/why-ai.html`, and all 10 `public/features/*.html` files. `public/css/features.css` totals **545 lines**.
- Google Fonts — `views/app.html:14-16`, `public/index.html:11`, `public/landing.html:14`, `public/login.html:11`, `public/signup.html:7`, `public/professional-services.html:11`, `views/signup-vertical.html:7-9`. Families loaded across the app: `Inter` (weights 300-900 depending on page), `Playfair Display` (weights 400/500/700/800 italic + roman), `Fraunces` (weights 400/500/600/700).
- No other external stylesheets are referenced.

### 6c. CSS custom properties (`--*`)

Only one file defines CSS variables:

| Variable | Value | Location |
| --- | --- | --- |
| `--bg-deep` | `#0a1420` | `views/signup-vertical.html:12` |
| `--bg-mid` | `#14263a` | `views/signup-vertical.html:13` |
| `--tier-1` | `#f5e6d3` | `views/signup-vertical.html:14` |
| `--tier-2` | `#d4af37` | `views/signup-vertical.html:15` |
| `--tier-3` | `#e2e8f0` | `views/signup-vertical.html:16` |
| `--tier-4` | `#94a3b8` | `views/signup-vertical.html:17` |
| `--forest` | `#86efac` | `views/signup-vertical.html:18` |
| `--gold` | `#d4af37` | `views/signup-vertical.html:19` |

No CSS custom properties are defined or consumed in `views/app.html`, `public/index.html`, `public/landing.html`, `public/css/features.css`, or any other audited file.

### 6d. `!important` usage (spot-count)

`views/app.html` uses `!important` heavily throughout the main `<style>` block from roughly line 300 onward, particularly on `.form-block input`, `.hero-title`, `.display-banner-*`, `#topbar`, `#sidebar`, `#homeCommandInput`, `#homeCommandResponse`, `.ai-response-body`, `.mode-card`, `.card`, `.section-label`, and various sidebar overrides. Notable clusters: `views/app.html:304-316` (form inputs), `views/app.html:784-836` (`display-banner-*` and `#homeCommandInput`), `views/app.html:1104-1146` (topbar/ai overrides), `views/app.html:1147-1250` (sidebar overrides), `views/app.html:1325-1366` (`.section-label`).

---

## 7. Worst Offenders

Ten items selected on the strength of the file:line evidence above.

1. **`.btn-primary` has at least six visually incompatible definitions across the codebase.** Same class name is a green-forest-gold gradient in the app (`views/app.html:460-465`), a coral-orange gradient in features/landing/login/signup (`public/css/features.css:157-168`, `public/landing.html:131`, `public/login.html:112`, `public/signup.html:115`, `views/signup.html:52`), a flat gold in index/professional-services (`public/index.html:66`, `public/professional-services.html:100`) — clicking the same-labeled "primary CTA" tells the user they're in a different app depending on where they came from.

2. **`<input>` elements ship four incompatible styles reachable from the same authenticated shell.** Global reset gives light `#fafbfc` (`views/app.html:430`), but `.form-block input` slams `!important` to switch to dark navy (`views/app.html:300-317`), while modal inputs stay light-mode `#dde3ec` (`views/app.html:12867`), and page-menu/page-inventory-ps/page-my-business roll their own `rgba(255,255,255,0.04)` inline pattern per element (`views/app.html:3545`, `views/app.html:3677`, `views/app.html:3920`, `views/app.html:3956`). No single input looks the same from screen to screen.

3. **Buttons: 40+ distinct button treatments across the codebase (Section 5a).** Many are hand-inlined `style="padding:... background:#d4af37; color:#0d1117; ..."` blocks that duplicate `.btn-primary` variant 18 (professional-services) without using the class — for example `views/app.html:3528`, `views/app.html:3549`, `views/app.html:3697`, `views/app.html:3735`, `views/app.html:3770`, `views/app.html:3843`, `views/app.html:3893`, `views/app.html:3922`, `views/app.html:3964`, `views/app.html:3977` all repeat "flat-gold pill button" with slightly different padding and radius.

4. **414 unique hex/rgba color literals (Section 2) with obvious near-duplicates that could be the same value.** Examples: `rgba(255,255,255,0.03)` (49 uses) vs `rgba(255,255,255,0.035)` (3) vs `rgba(255,255,255,0.04)` (81) vs `rgba(255,255,255,0.05)` (10) — four independent "very faint white overlay" tokens, some seen on adjacent elements. Same story for `rgba(212,175,55,0.10/0.14/0.15/0.16/0.18)`, `rgba(45,134,89,0.14/0.15/0.16/0.18)`, `rgba(255,107,107,0.06/0.07/0.08/0.10)`. Formatted variants of the same value (`rgba(212,175,55,0.28)` vs `rgba(212, 175, 55, 0.28)`) are counted separately because they render as separate strings.

5. **Home page `#homeCommandResponse` uses a cream light-mode surface inside the dark-navy home layout.** `views/app.html:2389` sets `background:rgba(248,247,243,0.7);border:1px solid rgba(232,220,210,0.7);color:#2d3748;` on the AI response block, then `views/app.html:853-864` immediately overrides it with `!important` to dark. Two full theme systems live at the same DOM address, and depending on which stylesheet wins the response block is either cream or navy.

6. **`.contact-name` renders ivory (`#f5e6d3`, `views/app.html:1663`) inside `.contact-card` whose background is `white` (`views/app.html:1639`).** Ivory-on-white is unreadable. Same problem on `.task-title` at `views/app.html:1713` inside `.task-item` which is placed on the dark task-list card in practice but has `background:#f8fafc` on hover (`views/app.html:1696`).

7. **The rent-payments table (`views/app.html:3384-3397`) uses a light-mode header (`background:#f4f6f9;`) with slate cell text inside the dark-navy `page-admin` card.** Sits directly next to Plan & Usage (`views/app.html:3265`) which is fully dark-mode. Two different themes in adjacent cards on the same screen.

8. **`.plan-price .period` at `font-size:0.28em` (`public/landing.html:319`).** That resolves to roughly 3.5-4px in browsers. The companion `.plan-price .dollar` at `0.45em` (`public/landing.html:318`) is also below the 8px readability floor. `views/app.html:2043` sets the mobile Command Center bubble at `0.88em` while `.cc-tool-summary` sits at `0.74em` — small text stacked inside small text.

9. **The signup flow ships two entirely separate landing systems.** `public/signup.html` (274 lines, dark navy card, coral gradient CTAs — `public/signup.html:8-167`) and `views/signup.html` (770 lines, light-mode background `linear-gradient(135deg,#f8fafc,#eef2ff)`, gray-scale card, coral CTAs — `views/signup.html:7-131`) look like they belong to different products. `views/signup-canceled.html:12` and `views/signup-success.html:12` also use the light `linear-gradient(135deg,#f8fafc,#eef2ff)` body while everything else in the product is dark.

10. **Dormant duplicate palette: the `.chat-*` classes at `views/app.html:1606-1635` are explicitly labeled "leftover from an earlier design and remain unused" (`views/app.html:1862-1863`) but still consume 30+ lines of CSS including their own coral gradient bubble, avatar shape, action chip, and quick-prompt.** The active Command Center (`views/app.html:1872-2046`) then re-ships all of these as `.cc-*` variants with a gold palette. Both sets ship to every user.
