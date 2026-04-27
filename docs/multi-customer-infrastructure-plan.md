# Multi-Customer Infrastructure Plan

## Vision
Modern Management transforms from "Jay's personal app" to "SaaS product strangers can sign up for and pay for." Multi-customer support is the foundation for launching to real customers.

## Product positioning
The Twilio number assigned to each customer is positioned as their main office line. Customers educate their tenants on a two-number model:
- Twilio number for general inquiries (AI handles)
- Customer's personal/desk number for direct contact (human handles)

No IVR, no extensions. Two numbers, customer education on which to use when.

## Customer shapes supported
- Solo landlord: 1 user, 1 workspace, multiple properties
- Small PM company: 1 workspace shared by team, multiple users
- Large PM company: multiple workspaces (1 per manager), each with own Twilio number

Database (Phase 1 work) supports all three. UI for team and multi-workspace deferred until after first customers.

## Pricing structure
- Solo: $79/month per workspace, up to 25 units, 1 user
- Team: $149/month per workspace, up to 100 units, 3 users included, +$25/user
- Enterprise: $299/month per workspace, up to 500 units, 10 users included, +$25/user
- Multi-workspace volume: 10% off at 5+, 20% off at 10+
- Annual: 2 months free

## Onboarding flow
1. Prospect contacts via marketing site
2. You schedule consultation call
3. During call: explain product, learn their needs, discuss area code preference
4. Customer goes to signup page (automated)
5. Signup form: account info, business info, area code preference, plan selection, Stripe payment
6. Behind the scenes: Stripe charge → account created → workspace created → Twilio number provisioned → webhooks configured → welcome email
7. Customer drops into in-app onboarding wizard
8. Wizard guides them through first property, units, contacts, knowledge base, automation settings

## Twilio integration decisions
- Fully automated provisioning (Decision 1: A1 — consultation first, then automated signup)
- Customer picks area code during consultation (Decision 2: B)
- SMS + voice capabilities on every number (Decision 3: A)
- Webhooks point to production server (Decision 4: A)
- 30-day grace period after cancellation (Decision 5: B)
- Base price plus usage overages (Decision 6: B)
- Single Modern Management Twilio account (Decision 7: A)

## Database schema changes (Migration 023)

### workspaces table additions
- twilio_phone_number TEXT NULL (E.164 format)
- twilio_phone_sid TEXT NULL (Twilio's internal ID)
- twilio_provisioned_at TIMESTAMPTZ NULL
- twilio_released_at TIMESTAMPTZ NULL
- business_name TEXT NULL
- area_code_preference TEXT NULL
- subscription_tier TEXT NULL
- subscription_status TEXT NULL
- canceled_at TIMESTAMPTZ NULL

### users table additions
- stripe_customer_id TEXT NULL

### Skipped (not needed yet)
- twilio_number_pool table (use Twilio API directly)
- onboarding_consultations table (use external CRM tools)
- automation table workspace-level changes (defer until needed)

## Webhook routing change
Current handlers (sms/incoming, voice/incoming, voice/recording, voice/transcription, email/incoming) assume one user. Rewrite each to:
1. Extract Twilio number from request (To field)
2. Look up workspace by twilio_phone_number where subscription_status='active'
3. Route message to that workspace's user
4. Log unrecognized numbers, don't crash

## Migration approach
- Phase A: Migration 023 + webhook routing + manual workspace setup for Jay's account
- Phase B: Signup form + Stripe + automated Twilio provisioning
- Phase C: In-app onboarding wizard
- Phase D: Admin tools for customer management
- Future: Team/multi-user features when needed

Estimated total: 25-35 hours across 4-6 sessions.
