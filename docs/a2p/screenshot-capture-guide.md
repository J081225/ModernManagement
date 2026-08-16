# A2P opt-in screenshots — capture guide (for Jay)

Danny (Twilio) requires **visual proof of opt-in**: a screenshot of the
consent checkbox screen the end user actually sees. I can't take
screenshots (no browser/camera on my side), so this is the exact recipe.
Capture these, save them here under `docs/a2p/`, upload to Google Drive,
set **"Anyone with the link can view,"** and hand me the links.

Do this **after** the deploy lands (the pages must be live — I'll confirm
in my report). All URLs are on production `https://modernmanagementapp.com`.

---

## Screenshot 1 — the END-USER opt-in form (the one Danny needs most)

**URL:** `https://modernmanagementapp.com/sms-opt-in?business=Bella%27s%20Salon`

- The `?business=…` fills the business name into the consent sentence so
  the reviewer sees it read naturally. Use your real pilot business name if
  you'd rather (URL-encode spaces as `%20`, apostrophe as `%27`), or delete
  the param to show the neutral "your business."
- **What the shot must show (one clean screenshot, all of it visible):**
  - the business + name + mobile-number fields,
  - the **consent checkbox LEFT UNCHECKED**,
  - the full consent sentence (Danny's exact template with the Privacy
    Policy + Terms of Use links),
  - the **"Sign me up for texts" button visibly greyed-out/disabled**
    (it stays disabled until the box is checked — that IS the proof the
    checkbox gates submission).
- Zoom the browser so the whole card fits in one frame if you can. Desktop
  is cleanest; a phone screenshot is fine too.
- **Optional second shot (stronger proof):** fill name + a number, **check
  the box**, and capture it with the button now ENABLED — shows the gate
  releasing only after consent. Nice-to-have, not required.

**Save as:** `docs/a2p/screenshot-1-end-user-opt-in.png`

---

## Screenshot 2 — the OWNER contact-intake form (secondary proof)

This is inside the app, so you'll be logged in.

1. Sign in → open your workspace.
2. Go to **Contacts** → click **Add Contact**.
3. Type a phone number in the Mobile field (so the consent checkbox is in
   context).
4. Capture the modal showing the **consent checkbox with Danny's wording**
   (unchecked). If you try to Save with a phone entered and the box
   unchecked, you'll get the "please confirm the customer consented" block
   — a shot of that alert is a nice bonus but not required.

**Save as:** `docs/a2p/screenshot-2-owner-intake.png`

---

## After capturing

1. Drop both PNGs in this folder (`docs/a2p/`).
2. Upload to Google Drive → for each, **Share → General access → Anyone
   with the link → Viewer.**
3. Paste the two share links back to me. I'll drop the end-user link
   (Screenshot 1) into the campaign's opt-in narrative and into your reply
   to Danny, then hand you the final resubmission to submit.

**I will NOT submit the campaign resubmission until you confirm the
screenshot link is in** — per your instruction.
