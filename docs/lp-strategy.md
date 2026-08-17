# LP1 — Landing page rebuild: investigation + strategy (no code)

Owner mandate: 10x the current page, professional-services focus, PM marked
tastefully "under construction," agency-grade craft. **The claims census
governs everything** — live features only (voice AI, Spanish, booking/
calendar, payments-with-honest-caveat, reports). No SMS / Arabic /
Square-live claims until true. The shipped pricing block (f59dd30) is the
keystone — built around, never rewritten.

**Honesty flag up front:** the mandate said to read
`/mnt/skills/public/frontend-design/SKILL.md` — that path is a claude.ai
container mount and **does not exist on this Windows machine** (searched
`.claude/` and the repo; no SKILL.md anywhere). I could not read it. §2
applies the skill's published principles from model knowledge (distinctive
typography, purposeful motion, no default-stack aesthetics). If Jay wants
the verbatim skill applied, run the LP2 build (or a review of this doc)
in a claude.ai session where the mount exists.

---

## 1. Audit of the current pages — every claim, verdict by verdict

### `/` (index.html, 446 lines — the multi-vertical chooser)

| Claim / element | Verdict | Evidence |
|---|---|---|
| Hero "An AI that runs your business…" | KEEP (concept) | Honest, but buries the voice-AI headliner |
| "**Reminders.**" in step 3 | **FALSE — anti-list** | No scheduler exists; `plans.ANTI_LIST` pins it |
| "**Daily summaries** / **Daily briefings**" (×2) | **FALSE** | `dailyBriefing` is a plans **flag only** — zero implementation (grep: no cron, no generator) |
| "Customers text. AI replies." | TRUE but **must not lead** | SMS is real code but the A2P campaign is in review — texting *our* claims-lead until approval is risky; voice is the star anyway |
| "Reports on demand" | TRUE | TR arc closed; `composeTransactionReport` live |
| "Inventory and vendors… drafts reorder messages" | TRUE | `message_vendor_for_restock` exists |
| "Strategy… Trends. Suggestions." | STALE/soft | Reflection layer exists but this oversells; rewrite honest |
| PM-first framing (equal cards) | STALE per mandate | PM becomes "under construction" |
| "Inc." | **NOT FOUND** | Grepped all public/ + views/ — © lines already say R2 LABS LLC. Either already fixed or misremembered; nothing to do |
| No voice AI anywhere on the page | **THE gap** | The single best live feature is absent |

### `/professional-services` (560 lines)

| Claim / element | Verdict | Evidence |
|---|---|---|
| Hero quote *"It books my appointments while I sleep… — Sarah, salon owner"* | **FABRICATED TESTIMONIAL — worst violation on the site.** Zero customers exist (the founding offer is literally "be among the first 10–15"). Doubly bad: the AI persona is named Sarah. | Must die in LP2. Replaced by the live demo (a real thing nobody can fake) |
| "Appointments… AI checks calendar, proposes times, confirms" | TRUE | appointment-engine + calendar |
| "Inbound texts, **emails**, and **voicemails** answered by AI" | TRUE (all three) | `/api/email/incoming` → engine; `/api/voice/incoming` records + transcribes → engine; relay answers live |
| "Customer records… AI finds it" | TRUE | contacts + search tools |
| "Inventory… drafts vendor messages; optional" | TRUE | honest as written |
| "Reports and insights… ask in plain English" | TRUE | TR arc |
| "**Daily briefing** … every morning" | **FALSE** | flag only, no implementation |
| Fear-handler section ("What if the AI says something wrong?") | **KEEP — best section on the site** | Matches the product's real approval architecture (no-self-approve law) |
| Approval-queue **hand-built mock** (`REPLACE WITH IMAGE` comment still in source) | STALE per mandate | Replace with a real screenshot of the real Pending Approvals card |
| Pricing block (f59dd30) | **KEYSTONE — as-is** | Census-pinned by `test-pricing-claims.js` (6 checks); restyle the shell only, never the copy/structure |
| No voice AI, no Spanish, no payments/report features above the pricing block | **THE gap** | The body of the page still sells the text-first 2025 product |

### `/property-management` (457 lines)
Tier ladder $79/$149/$299 with "Daily briefing" rows; PM signup still sells
solo/team/enterprise via Stripe lookup_keys. **Flagged inconsistency (new):**
since the plans.js collapse, a PM signup would charge $79/mo Stripe but
resolve to the $320 Professional plan config in-app. PM is being marked
under construction anyway — see ruling R6 (recommend: disable PM signup,
waitlist instead).

**Keep list (concepts that survive):** honesty-as-brand (fear-handler), the
teach-it-plain-English story, "nothing happens without your approval," the
who-it's-for grid (tightened), the pricing keystone, R2 LABS LLC footer.

---

## 2. Design direction (skill principles applied — see honesty flag above)

### Typography — distinctive, non-default
- **Display: Fraunces** (Google Fonts, variable; optical-size + "wonk" axes).
  High-contrast editorial serif — reads boutique-hotel-concierge, not SaaS
  template. Hero at 600–700 weight, tight leading, optical size cranked.
- **Text: Instrument Sans** (Google Fonts) — modern grotesque with
  character; deliberately NOT Inter (the current page's default-stack tell).
- **Mono: Spline Sans Mono** — for the live-call transcript, phone numbers,
  prices, and the "PAID" state. The transcript IS a UI element; mono makes
  it feel like real machinery.
- Scale: fluid clamp() steps, hero ~clamp(3em, 7vw, 5.5em); body 1.0–1.05em.

### Palette — built from deep forest green
| Token | Hex | Role |
|---|---|---|
| `--forest-950` | `#071510` | Page background (near-black green) |
| `--forest-900` | `#0B1F17` | Section alternate / cards |
| `--forest-700` | `#1F5B3F` | Borders, active states |
| `--emerald` | `#2E8B61` | Live indicators, success, the PAID flip |
| `--cream` | `#F4EFE6` | Primary text on dark; light-section bg |
| `--brass` | `#C9A96A` | Accents, eyebrows, hover glow (evolves the current gold, softened) |
| `--ink` | `#132A20` | Text on cream sections |

Dark forest is the base; **one full-bleed cream "paper" section** mid-page
(the honesty section) as the palette inversion moment. Brass replaces the
current brighter gold. No purple, no blue gradients, no emoji icons —
replace the current emoji pills with thin-line brass SVG glyphs.

### Motion language — purposeful, physical, quiet
- **Hero transcript**: words of the real recorded call appear as spoken
  (timed to the audio) — the page's signature motion. Mono type, emerald
  cursor. This is content-as-motion, not decoration.
- Scroll-triggered reveals: IntersectionObserver, translateY(14px)→0 +
  opacity, 70ms sibling stagger, once-only. No scroll-jacking, ever.
- Hover physics: cards lift 3px on a spring curve
  (`cubic-bezier(.2,.9,.3,1.2)`) with a brass border-glow bloom.
- Real-UI clips (§4) autoplay muted in-viewport, pause out.
- `prefers-reduced-motion`: every animation collapses to opacity or a
  static real screenshot. Non-negotiable.

### Component vocabulary
- **Proof-carrying cards**: every feature card contains a real artifact —
  a real transcript fragment, a real report excerpt, a real calendar frame.
  No card ships with lorem-flavored abstraction. (Census, applied to design.)
- Numbered editorial sections (01–06, Fraunces numerals) instead of the
  current anonymous card grids.
- Sticky brass section eyebrows; stat strip of product truths only
  ("24/7", "English & Español", "2 rings"); device-framed clips.
- **Empty testimonial slot, on purpose**: a "Founding customers" band that
  says the quotes will be earned — turns the fake-Sarah deletion into a
  trust move.

---

## 3. Section architecture — hero as a WORKING demo

**Structural proposal (ruling R1):** the root `/` becomes the flagship
PS-focused page (one killer page, no chooser). PM demotes to a nav/footer
link with an "in development" badge. `/professional-services` 301s or
mirrors to `/`.

**POSITIONING RULING (Jay, 2026-08-16): the receptionist is the DOOR, not
the house.** The product is an AI running the whole business — front desk,
calendar, inbox, payments, books, reports, assistant on every screen. The
hero stays (proof-in-five-seconds); THE REVEAL (new section 4) turns the
corner from phone tool to whole system; the pricing headline widens to
"One price. Your whole business, run by one AI." (hero eyebrow keeps
"AI receptionist…" — that's the demo's promise); sub-copy may say "front
desk and back office." How-she-works sharpens into ONE FLOW (phone →
calendar → inbox → books). The three real-UI clips FOLD INTO the reveal
as its proofs (static real screenshot until Jay's captures land, then
motion) — the reveal is the story, the grid is the inventory.

**SECTION ORDER — updated 2026-08-16 (positioning ruling + the two
content additions). Supersedes prior tables; the LP2+ design brief's
build rules still apply (one section per commit, browser-reviewed).**

| # | Section | Content |
|---|---|---|
| 0 | Nav | Forest glass blur, brass CTA "Start free trial" — SHIPPED (LP2) |
| 1 | **HERO — the working demo** | SHIPPED (LP2): live demo line (332) 249-4333, transcript rig dark until the real recording lands |
| 2 | **WHO IT'S FOR strip** (added) | Profession chips, forest/brass, labels-not-links, 2-second scannable, clean mobile wrap: Salons · Barbers · Makeup artists · Pet groomers · Physical therapists · Personal trainers · Massage therapists · Estheticians · Nail techs · Tutors · Photographers · Cleaners. Closer: "If it's booked by appointment, she answers it." |
| 3 | The missed-call math | One huge Fraunces number — a missed booking's monthly cost, pure arithmetic from the demo shop's real menu (assumption cited honestly, NO external stats). Fear-handler bones live in §7 |
| 4 | **THE REVEAL** (added — positioning ruling) | "She's not just answering the phone. She's running the desk." Real product tour, one system not a feature list, each room with REAL screenshot proof (clips fold in when captured): Calendar (bookings land live) · Inbox (calls/texts/emails/voicemails in one place — texts caveat: inbound today, outbound pending carrier) · Payments (links/receipts/refunds) · Books (transaction report + expenses + budget) · Reports (week-ahead briefing) · The Assistant (on every screen — say it, she does it) |
| 5 | How she works | ONE FLOW, 3 cards sharpened: phone → calendar → inbox → books. One claim + one proof each |
| 6 | **EVERYTHING SHE DOES grid** (added) | Comprehensive LIVE-features grid, one honest sentence each: 24/7 answering & booking · English + Spanish · calendar booking with real services/prices · knowledge base + approval controls · honest payments (Stripe/Square links, receipts, real refunds; Venmo/Zelle info, manual confirm — VERIFIED live, lib/direct-payments) · transaction report (printable/exportable) · the on-every-screen assistant · narrative reports (activity, customers, week ahead) · contacts/tasks/calendar · dedicated business number · security posture (password-gated changes, verified contacts, change alerts). Gated items (SMS, more languages) STAY OUT — they are the honesty section's job. Cards carry a real screenshot or transcript fragment as proof where one exists; no decorative icons standing in for proof |
| 7 | **The honest section** (cream paper inversion) | "What she doesn't do yet" — gated items truthfully (texting: pending carrier approval; more languages: coming) + REAL approval-queue screenshot + fair-dealing lines |
| 8 | **Pricing — the keystone** | f59dd30 numbers/structure verbatim; ONE ruled headline change (2026-08-16): "One price. Your whole business, run by one AI."; shell restyled to new tokens; `test-pricing-claims.js` must stay green |
| 9 | Founding offer | Its own moment; the $160 trade plain-spoken; earned-testimonial promise |
| 10 | Footer | R2 LABS LLC, legal links, PM "under construction — join the waitlist" badge + waitlist form (replaces PM signup, R6) |

### The live demo line (rulings R2/R3)
- **Mechanics:** a dedicated **demo workspace** ("the demo salon" — clearly
  labeled fictional business) + its own Twilio local number (~$1.15/mo)
  with the voice URL pointed at `/api/voice/relay-incoming`. Seeded
  services menu + calendar so callers can genuinely book. Recommended over
  reusing ws17 (R2 Labs is a real dev workspace; a public number on it
  pollutes real data).
- **Compliance:** voice is NOT A2P — the demo line is compliant **today**.
  Constraint: the demo workspace must NOT send SMS confirmations until the
  campaign clears (voice-only behavior; booking confirmed verbally).
- **Cost guard:** demo calls cost ~$0.07–0.10/min. Cap exposure with a
  short max-duration for the demo workspace + monitor; fair-use math says
  even 300 demo calls/mo ≈ $90–120 — a marketing spend Jay should size (R2).

### The recorded hero call (ruling R3 — Jay produces)
- 25–40 seconds, **a real call to the demo number**: caller asks for an
  appointment, AI checks the calendar, offers a slot, books it.
- Deliverables: audio (the source of truth), a screen capture of the
  calendar showing the booking land (for §4-1), and the exact transcript
  (drives the typing animation — real words only).
- Format: mp4 + webm, ≤6MB, poster frame, captions on by default, muted
  autoplay never (audio is the product — play on tap).

---

## 4. Real-product motion plan — no fake screens

All three sequences are **screen recordings of the real app** on the demo
workspace (2× DPR, trimmed loops ≤15s, lazy-loaded webm + poster, static
real screenshot under reduced-motion). The current PS page's hand-built
approval mock (and its `REPLACE WITH IMAGE` comment) dies.

1. **Booking lands on the calendar** — record the real calendar view as the
   demo call's appointment appears. (Pairs with the hero call audio.)
2. **Payment link → PAID flip** — real transaction in the app, real Stripe
   test-mode payment link, test-card payment, status flips PAID + receipt.
   On-screen caveat carried honestly: card payments via Stripe (test-mode
   today) or Square (sandbox-verified; production cutover pending) — exact
   wording per the census at build time; **no "Square live" claim**.
3. **Spanish conversation** — a seeded demo customer with
   `customer_language = es`; record the real inbox thread as the AI replies
   in Spanish. (Text surface — voice stays "English & Spanish" only as
   already census-passed in the pricing block.)

Production notes: capture together in one session on the demo workspace
(~1 hour of Jay's time, guided), consistent window size/zoom, no personal
data in frame.

---

## 5. Copy strategy

- **Anchor:** receptionist replacement. "A full-time receptionist runs
  $3,000–$4,000 a month. This is $320." The pricing block already owns this
  line — the hero sets it up, never repeats it verbatim.
- **Voice-first narrative:** every section answers "what happens when the
  phone rings?" The old text-first story becomes secondary (and SMS stays
  out of active copy until the campaign clears — gated line already staged
  in the pricing block).
- **Honesty as the brand voice:** we sell the approval queue, the fair-use
  no-surprise-overage clause, and the "in carrier review" FAQ as features.
  This page's differentiator is that every artifact on it is real.
- **No fabricated social proof** — fake Sarah dies; the live demo number is
  the testimonial. Founding band promises earned quotes.
- **Pricing block untouched** (copy/structure); only its container restyles.

---

## 6. Owner rulings needed before LP2

| # | Ruling | Recommendation |
|---|---|---|
| R1 | Page structure: does `/` become the PS flagship (no chooser), PM demoted to badge link? | Yes — one page, one story |
| R2 | Demo line: new dedicated number + demo workspace? Budget cap for demo call minutes? Max call duration? | New number; ~$50–120/mo exposure accepted; 5-min cap |
| R3 | Recorded hero call: Jay records per §3 spec — approve production plan + pick the demo business name (clearly-labeled fictional, e.g. "Marlowe & Co. Salon") | Approve; name Jay's call |
| R4 | Tone dial: concierge-calm ("Your phone, answered. Forever.") vs punchy-direct ("Stop losing customers to voicemail.") | Concierge-calm headline, punchy section leads |
| R5 | PM treatment: exact badge wording ("In development — join the waitlist"?) and whether `/property-management` stays reachable | Reachable, badged, pricing section removed |
| R6 | **PM signup:** currently still sells solo/team/enterprise ($79–$299 Stripe) while plans.js now resolves everyone to Professional — disable PM signup → waitlist until PM relaunch? | Disable + waitlist (flagged inconsistency from the collapse) |
| R7 | Photography: none (type + real UI + texture only) vs any real imagery | None — real UI is the imagery |
| R8 | Skill-file gap (see top): accept knowledge-applied principles, or route LP2 through a claude.ai session with the skill mounted? | Jay's call |

**Build sequence after rulings:** LP2 = design tokens + nav + hero shell
(typing transcript rig, demo card w/ placeholder number) → LP3 = demo
workspace + number provisioning → LP4 = feature blocks as clips land →
LP5 = honest section + FAQ → LP6 = pricing shell restyle (census gate green)
→ LP7 = PM badge treatment + redirects. One section per commit, each
reviewed in the browser. `test-pricing-claims.js` runs at every step;
index.html's false "Reminders / Daily briefings" lines die in the first
commit that touches the page.
