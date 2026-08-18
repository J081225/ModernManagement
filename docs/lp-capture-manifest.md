# LP capture manifest — filenames, captions, drop-in contract

Drop the files into **`public/img/product/`** with EXACTLY these names;
I swap each frame's honest empty for the `<img>` + caption in one commit
per delivery (no layout work — frames are pre-sized). LC9 enforces that
every image on the page comes from this folder.

| File | Frame | Status | Caption (lands with the image) |
|---|---|---|---|
| `calendar.png` | Calendar | **APPROVED as shot** | "August, live: bookings and blocked time, both honored — she won't book into either." |
| `inbox.png` | Inbox | **APPROVED** | "A real call thread — this one in Spanish. Take over anytime." |
| `payments.png` | Payments | **APPROVED** | "Stripe and Square connected; one active. Venmo & Zelle: manual confirm, honestly labeled." |
| `books.png` | Books | Jay picks the shot | "Every row real. Printable, exportable." — works for EITHER candidate (TR report card preferred if rows render; else the transactions list with the PAID row + Export CSV visible) |
| `assistant.png` | The Assistant | Approved AFTER ~40px top crop | "Say it, she does it — and logs which tool did the work." |
| `reports-request.png` | Reports — slot 01 (the ask) | Shot exists (New Report modal) | Duo caption: "You ask in plain English. She answers in a report." |
| `reports-result.png` | Reports — slot 02 (the report) | Shot exists (Productivity report) | (shared duo caption above) |

## The two-image reports frame (ruled)
Built: `.proof-frame.duo` — request → result, side-by-side on desktop,
stacked on mobile, slots labeled **"01 — the ask"** / **"02 — the
report."** Each slot independently holds a capture or the honest empty.
LC9 updated: slots (not frames) are the honesty unit; 6 frames = 7 slots.

## Crop service for assistant.png
Send the uncropped file — I'll crop the top ~40px locally (PowerShell /
System.Drawing), verify the annotation sliver is gone, and commit the
cropped file. Or crop it yourself before dropping it in; either works.

## Notes
- The inbox shot doubles as the Spanish proof — a real es voice thread.
- The books candidates are both honest; caption carries
  "printable, exportable" either way (both live: printReport /
  exportReportCsv / exportTransactionsCsv).
- Real customer data must not appear in any shot (the demo/test numbers
  visible in the delivered shots are fine).
