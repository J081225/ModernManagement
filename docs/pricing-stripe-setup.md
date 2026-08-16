# Pricing Stripe setup — one plan (for Jay)

The 2026-08-16 collapse wired the code to resolve the Professional Services
price by **billing cadence** (not tier). The code is deployed; it just needs
three Stripe **price** objects and three env vars. Until they're set, PS
signup returns a clear "pricing not configured" error (it does not crash).

Do TEST mode now; redo in LIVE mode when we flip Stripe to live (the code
reads the same env-var names — you just swap the values).

---

## 1. Create one Product, three Prices (Stripe Dashboard → Products)

Product: **Modern Management** (one product; three prices under it).

| Price | Amount | Billing | Env var to set |
|---|---|---|---|
| Monthly | **$320.00** | Recurring, monthly | `STRIPE_PRICE_PS_MONTHLY` |
| Annual | **$3,200.00** | Recurring, yearly | `STRIPE_PRICE_PS_ANNUAL` |
| Founding | **$160.00** | Recurring, monthly | `STRIPE_PRICE_PS_FOUNDING` |

- After creating each price, copy its **Price ID** (`price_…`, NOT the
  product id) into the matching env var.
- The 7-day trial is applied by the app at checkout — do **not** set a trial
  on the price itself.
- Annual is a true yearly price ($3,200 = ~2 months free vs $320×12=$3,840).

## 2. Set the env vars (Render → the web service → Environment)

```
STRIPE_PRICE_PS_MONTHLY   = price_…   (the $320/mo price id)
STRIPE_PRICE_PS_ANNUAL    = price_…   (the $3,200/yr price id)
STRIPE_PRICE_PS_FOUNDING  = price_…   (the $160/mo founding price id)
```

Save → Render redeploys → the startup warning about missing PS price env
vars disappears and PS signup works.

## 3. Retire the old env vars (optional cleanup)

These backed the retired tiers and are no longer read — safe to delete:
`STRIPE_PRICE_PS_STARTER_MONTHLY`, `STRIPE_PRICE_PS_PRO_MONTHLY`,
`STRIPE_PRICE_PS_PREMIUM_MONTHLY`.

## 4. Founding ($160) is GATED — not self-serve

Public signup only offers **monthly** and **annual** — no one can self-select
the $160 founding price. The founding price exists so you can put a founding
customer on it deliberately:

- **Simplest:** in the Stripe Dashboard, create the subscription for the
  founding customer on the `$160/mo` price directly, or send them a Payment
  Link built on that price.
- A gated founding **signup link** (e.g. `?billing=founding` behind a code)
  can come later in the LP arc if you want it self-serve for the cohort.

Either way: the trade (testimonial + call recordings + monthly feedback,
locked 12 months) is a conversation/agreement you have with each of the first
10–15 — it's stated plainly on the landing page.

## 5. Live-mode swap (when Stripe goes live)

Recreate the same three prices in **live** mode, then replace the three env
var values with the live `price_…` ids. No code change. (This rides the same
"gated on Stripe live-mode" sequence as SQ6.)
