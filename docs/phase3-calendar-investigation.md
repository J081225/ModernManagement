# Phase 3 — Calendar Investigation

## 1. FRONTEND MAP

### 1.1 `page-calendar` markup structure

All markup lives in `views/app.html:2402-2441`.

| Lines | Element | Notes |
|---|---|---|
| 2402 | `<div class="page" id="page-calendar">` | Page root. Visibility toggled by `showPage()` adding/removing `.active` (`views/app.html:3879-3882`). |
| 2403 | `<div class="page-content">` | Wrapper. |
| 2404-2411 | `.page-hero` | Static hero: title "Calendar", sub "Events, scheduling and upcoming appointments" (`views/app.html:2408-2409`). |
| 2412 | `<div style="display:flex;gap:22px;">` | Two-column shell. Inline flex, **not** a named class — no media query targets it. |
| 2415-2430 | Left column `flex:1` → `.card` | Holds the nav bar and both grids. |
| 2417-2426 | `.cal-nav` | Prev arrow (2418), month `<select id="calMonthSel">` (2419), year `<select id="calYearSel">` (2420), next arrow (2421), spacer (2422), Today (2423), Year toggle (2424), `+ Add Event` (2425). |
| 2427 | `<div class="calendar-grid" id="calDayHeaders">` | Sun–Sat header row. Emptied and `display:none`d by year view (`views/app.html:4991-4993`). |
| 2428 | `<div class="calendar-grid" id="calGrid">` | The single container reused by **both** month view and year view; the class is swapped between `calendar-grid` (`views/app.html:4948`) and `cal-year-wrap` (`views/app.html:4996`). |
| 2433-2437 | Right column `width:300px;flex-shrink:0` | Fixed-width day-detail sidebar. |
| 2434-2436 | `<div class="card" id="dayDetailPanel">` | Placeholder copy until a day is clicked; fully replaced by `renderDayDetail()` (`views/app.html:5098-5118`). |

Supporting CSS: `.calendar-grid` `views/app.html:433-438` (7-column grid), `.cal-header` 439, `.cal-day` 440-456, `.cal-nav` 457-470, `.cal-year-wrap` 471-476, `.cal-mini*` 477-505.

Calendar-related markup outside the page div:
- Event detail modal — `views/app.html:3780-3792`.
- Block-off modal — `views/app.html:12856-12890`.
- Global calendar state — `let calYear, calMonth;` (`views/app.html:3859`), `let calEvents = [...]` seeded with three hard-coded 2026 demo rows (`views/app.html:3861-3865`), `let calView = 'month'` (`views/app.html:4846`), `let selectedDate = null` (`views/app.html:4902`), `let tasks = []` (`views/app.html:5920`).

### 1.2 Every JS function involved in rendering the calendar

| Function | Lines (`views/app.html`) | What it does | Called by |
|---|---|---|---|
| `initCalendar` | 4848-4854 | Sets `calYear`/`calMonth` to today, forces `calView='month'`, calls `renderCalendar()`. | `window.onload` (8846) — **only** caller. |
| `changeMonth` | 4856-4861 | Steps `calMonth` ±1 with year rollover, re-renders. | `changeCalNav` (4870). No markup calls it directly. |
| `changeCalNav` | 4865-4872 | Arrow handler: steps years in year view, delegates to `changeMonth` in month view. | `onclick` on both arrows (2418, 2421). |
| `onCalMonthChange` | 4874-4879 | Sets `calMonth` from the select; zooms year→month if in year view. | `onchange` on `#calMonthSel` (2419). |
| `onCalYearChange` | 4881-4884 | Sets `calYear` from the select, re-renders. Does **not** change `calView`. | `onchange` on `#calYearSel` (2420). |
| `jumpToToday` | 4886-4895 | Resets year/month to today, forces month view, sets `selectedDate` to today's `YYYY-MM-DD`, re-renders + opens the day panel. | `onclick` on `#calTodayBtn` (2423). |
| `toggleCalView` | 4897-4900 | Flips `calView` between `'month'` and `'year'`, re-renders. | `onclick` on `#calViewToggleBtn` (2424). |
| `syncCalHeader` | 4908-4932 | Lazily populates the month select once, rebuilds the year select every call over `min(now-1, calYear) .. max(now+5, calYear)`, sets both values, relabels the toggle button. | `renderCalendar` (4935) — only caller. |
| `renderCalendar` | 4934-4939 | Orchestrator: `syncCalHeader()` → `renderYearView()` or `renderMonthView()` → `renderDayDetail(selectedDate)` if a day is selected and in month view. | 4853, 4860, 4868, 4878, 4883, 4893, 4899, 5041, 5047, 5927, 5932, 8273, 4098. |
| `renderMonthView` | 4941-4977 | Builds the Sun–Sat header, leading empty cells, then one `.cal-day` per day with a dot row: one dot per matching `calEvents` row + one per incomplete task. Uses string concatenation into `grid.innerHTML` inside the loop. | `renderCalendar` (4937). |
| `renderYearView` | 4985-5033 | Renders 12 mini-month grids for `calYear`. Precomputes a `Map` of `dateStr → 'coral'|'gray'` (5003-5010) so any non-`time_off` event beats a `time_off`-only day. | `renderCalendar` (4936). |
| `openMonthFromYear` | 5037-5043 | Sets `calMonth`, forces month view, optionally sets `selectedDate`, re-renders and opens the day panel. | Mini-month header `onclick` (5028) and mini-day `onclick` (5026, with `event.stopPropagation()`). |
| `selectDay` | 5045-5049 | Sets `selectedDate`, re-renders grid + day panel. | `.cal-day` `onclick` (4972); AI focus navigation (4096). |
| `renderDayDetail` | 5051-5119 | Rebuilds `#dayDetailPanel` innerHTML: formatted date header, events list, tasks list, and three action buttons. | 4894, 5042, 5048, 4938, 5205, 5217, 5490, 5513. |
| `loadCalEvents` | 5930-5933 | `calEvents = await api('calevents') || []` then `renderCalendar()`. The **only** fetch of calendar events. | 8846 (onload), 5204, 5216, 5489, 5512, 5542, 5949, 8272. |
| `loadTasks` | 5923-5928 | `tasks = await api('tasks')`, then `renderTasks()`, `updateTaskBadge()`, `renderCalendar()` — so a task load also re-renders the calendar. | 8859 (onload), 5543, 5967, 5974, 5979, 5991, 5995, 8292. |
| `openAddEventOnDate` | 5121-5128 | Opens `#eventModal` with the date prefilled. | Day-panel `+ Add Event` button (5114). |
| `openAddEvent` | 5520-5527 | Same modal, blank date. | `.cal-nav` `+ Add Event` (2425). |
| `closeEventModal` | 5529-5531 | Hides `#eventModal`. | Modal footer. |
| `submitAddEvent` | 5533-5545 | `POST /api/calevents {date,title}`; optionally also `POST /api/tasks`; then `loadCalEvents()` + `loadTasks()`. Sends **no** `event_type` and no times → server defaults to `general` + all-day. | `#eventModal` save button. |
| `openAddTaskOnDate` | 5130-5136 | **Navigates away** from the calendar to the Tasks page and prefills `#taskDueDate` (2710). | Day-panel `+ Add Task` (5116). |
| `openBlockOffTime` | 5143-5152 | Resets and opens `#blockOffModal` with the date prefilled and whole-day checked. | Day-panel `Block off time` (5115). |
| `closeBlockOffModal` | 5154-5156 | Hides the modal. | 12856, 12886. |
| `onBlockOffWholeDayChange` | 5158-5164 | Shows/hides and enables/disables the start/end time row. | 5150 and checkbox `onchange` (12865). |
| `submitBlockOff` | 5166-5212 | Validates, `POST /api/calevents` with `event_type:'time_off'`, then `loadCalEvents()` + `renderDayDetail()`. | `#blockOffSaveBtn` (12887). |
| `deleteCalEvent` | 5214-5218 | `DELETE /api/calevents/:id`, then reload. No confirm prompt. | The `✕` in the day-panel event row (5082). |
| `openCalEventDetail` | 5255-5279 | Shows the modal in a loading state, `GET /api/calevents/:id`, hands the payload to `renderCalEventDetail`. | Event title span in the day panel (5081). |
| `renderCalEventDetail` | 5286-5360 | Populates title/meta/body/actions from `{event, appointment, contact}`; stashes the payload on `window._openCalEventData` (5351). | 5273, 5477, and the "Back" button (5422). |
| `closeCalEventDetail` | 5281-5284 | Hides the modal. | 3780, 3787, 5359, 5511. |
| `calEventDetailEdit` | 5381-5423 | Swaps the modal body for a Service/Date/Time/Duration/Price form built from the stashed payload. Returns early if `data.appointment` is absent. | Edit button (5353). |
| `calEventDetailSave` | 5425-5495 | Validates, `PATCH /api/appointments/:id`, re-fetches `GET /api/calevents/:id`, re-renders, flashes "Saved!", then `loadCalEvents()` + `renderDayDetail()`. | Save button (5421). |
| `calEventDetailDelete` | 5497-5518 | `confirm()` then `DELETE /api/calevents/:id`, closes, reloads. | Cancel/Delete button (5357). |
| `_calEscape` | 5227-5229 | HTML-escapes a value. | Throughout the detail modal. |
| `_calFormatDate` | 5231-5237 | `toLocaleDateString('en-US', …)` — **no `timeZone` option**. | 5296. |
| `_calFormatTime` | 5238-5244 | `toLocaleTimeString('en-US', …)` — **no `timeZone` option**. | 5297. |
| `_calDurationMinutes` | 5245-5253 | Minutes between two ISO strings, or `null`. | 5301. |
| `_calSplitLocalDateTime` | 5366-5377 | Splits an ISO into `YYYY-MM-DD` + `HH:MM` using `getFullYear/getMonth/getDate/getHours/getMinutes` — **browser-local**. | `calEventDetailEdit` (5386). |
| `ensureDailyNudge` | 5940-5952 | `POST /api/daily-nudge/ensure`; on `created` calls `loadCalEvents()` (5949). | `window.onload` (8847). |
| `toggleTask` | 5970-5975 | `PUT /api/tasks/:id` with `done` flipped, then `loadTasks()` (which re-renders the calendar). | Day-panel task ✓ (5092). |
| `deleteTask` | 5977-5980 | `DELETE /api/tasks/:id`, then `loadTasks()`. | Day-panel task ✕ (5093). |
| `refreshPageData` | 8259-8302 | `case 'calendar'` (8270-8274) calls `loadCalEvents()`, else falls back to `renderCalendar()`. | 8336 (AI tool-map dispatch), 8033-8035, 8093-8094, 12268. |

**38 functions documented.**

### 1.3 The event-detail popup

**Markup** — `views/app.html:3780-3792`. A `.modal-overlay` with `display:none` inline, containing four addressable nodes: `#calEventDetailTitle` (3784), `#calEventDetailMeta` (3785), `#calEventDetailBody` (3789), `#calEventDetailActions` (3790). No form markup — the edit form is injected at runtime by `calEventDetailEdit` (`views/app.html:5395-5418`).

**Endpoints called**

| JS | Request | Handler |
|---|---|---|
| `openCalEventDetail` (5270) | `GET /api/calevents/:id` | `server.js:3932-3984` |
| `calEventDetailSave` (5461) | `PATCH /api/appointments/:id` | `server.js:4083-4201` |
| `calEventDetailSave` (5473) | `GET /api/calevents/:id` (re-fetch) | `server.js:3932-3984` |
| `calEventDetailDelete` (5503) | `DELETE /api/calevents/:id` | `server.js:3992-4074` |

**What "Cancel" actually does at the DB level**

The button is labelled `Cancel appointment` when `event.appointment_id || appointment` is truthy, otherwise `Delete` (`views/app.html:5346-5347`). Both labels hit the same `DELETE /api/calevents/:id`.

Tracing `server.js:3992-4074`:

- **No `appointment_id`** (plain event, block-off, daily focus): hard `DELETE FROM cal_events` (`server.js:4065-4068`). The row is gone; nothing is retained.
- **Has `appointment_id`**: the appointment is **soft-cancelled**, not deleted —
  ```
  UPDATE appointments SET status = 'canceled', canceled_at = NOW(), canceled_by = $1, canceled_reason = $2, updated_at = NOW()
  ```
  with `canceled_by='staff'` and `canceled_reason=null` hardcoded (`server.js:4044-4052`). The appointments row survives with full history.
- **But the calendar row is hard-deleted anyway**: `DELETE FROM cal_events WHERE id = $1` on `appt.cal_event_id` (`server.js:4054-4060`). So a cancelled appointment vanishes completely from the calendar — there is no "cancelled" visual state on the grid, because the grid only reads `cal_events`.
- Already-cancelled appointments: the stray `cal_events` row is deleted and `{alreadyCancelled:true}` returned (`server.js:4038-4043`).
- Orphaned `cal_events` rows pointing at a missing appointment are hard-deleted (`server.js:4032-4037`).
- Legacy pre-workspace rows fall back to a `user_id`-scoped hard delete (`server.js:4013-4020`).

This mirrors `lib/tools/cancel_appointment.js:43-60` exactly (same `'canceled'` token, same three timestamps, same `cal_events` delete at line 58).

**What "Edit" actually does at the DB level**

`calEventDetailSave` sends `{title, starts_at, duration_minutes, quoted_price_cents?}` to `PATCH /api/appointments/:id` (`views/app.html:5447-5465`). `starts_at` is a **naive** `YYYY-MM-DDTHH:mm` built from the two inputs (`views/app.html:5446`).

The handler writes to **both tables**:

1. `appointments` — a dynamic `UPDATE` over the collected fields plus `updated_at = NOW()` (`server.js:4152-4166`). `starts_at` goes through `toZonedISO(body.starts_at, wsTz(workspace))` (`server.js:4130`); `ends_at` is recomputed as `starts_at + duration_minutes` whenever either changed (`server.js:4143-4145`).
2. `cal_events` — only if `current.cal_event_id` is set **and** one of `starts_at`/`ends_at`/`title` changed (`server.js:4171`):
   ```sql
   UPDATE cal_events SET starts_at = COALESCE($1, starts_at), ends_at = COALESCE($2, ends_at),
                         title = COALESCE($3, title), date = COALESCE($4, date) WHERE id = $5
   ```
   (`server.js:4174-4185`). The legacy `date` TEXT column is written as `new Date(updates.starts_at).toISOString().slice(0, 10)` (`server.js:4183`) — the **UTC** date, not the workspace-local date.

The `cal_events` sync is wrapped in its own try/catch that only logs on failure (`server.js:4186-4188`), so the two tables can diverge silently. Price and notes are appointment-only; they never reach `cal_events`.

### 1.4 The day-detail sidebar

**Markup**: `views/app.html:2433-2437` — a fixed `width:300px;flex-shrink:0` column holding `<div class="card" id="dayDetailPanel">` with placeholder copy at 2435.

**`renderDayDetail(dateStr)` — `views/app.html:5051-5119`**

- Date label from `new Date(dateStr + 'T00:00:00')` (5052) — parsed as **browser-local midnight** — formatted via `toLocaleDateString` with weekday/month/day/year (5053).
- Events: `calEvents.filter(e => e.date === dateStr)` (5054) — legacy TEXT column match.
- Tasks: `tasks.filter(t => t.dueDate === dateStr)` (5055). Note this includes **done** tasks, unlike the month grid which filters `!t.done` (4965).
- Each event row (5057-5085): a time prefix of `'All day · '` when `is_all_day` (5066-5067), else `new Date(e.starts_at).toLocaleTimeString(...)` in **browser-local** time (5070), else nothing for legacy date-only rows. `time_off` rows render with `--bg-sunken` background, muted `✕`, and a 🚫 icon; everything else uses `--danger-soft` and a 📅 icon (5076-5079). The title span calls `openCalEventDetail(e.id)` (5081); the `✕` calls `deleteCalEvent(e.id)` with `event.stopPropagation()` (5082).
- Each task row (5087-5096): title with strike-through when done, a toggle span calling `toggleTask(t.id)` (5092), a delete span calling `deleteTask(t.id)` (5093).
- Empty states: "No events." (5085) / "No tasks." (5096).
- **Three buttons** at 5113-5117: `+ Add Event` → `openAddEventOnDate` (5114), `🚫 Block off time` → `openBlockOffTime` (5115), `+ Add Task` → `openAddTaskOnDate` (5116).

The whole panel is rebuilt via `innerHTML` assignment (5098), so any transient DOM state inside it is destroyed on every render.

### 1.5 Month/year selects and Today/Year controls — wired vs. stub

| Control | Markup | Handler | Status |
|---|---|---|---|
| Prev arrow `←` | 2418 | `changeCalNav(-1)` 4865-4872 | **Fully wired.** Steps months in month view, years in year view. |
| Next arrow `→` | 2421 | `changeCalNav(1)` 4865-4872 | **Fully wired.** |
| Month select | 2419 | `onCalMonthChange` 4874-4879 | **Fully wired** for navigation. Options are built once and never rebuilt (`if (!monSel.options.length)`, 4914-4916); value re-synced every render (4917). |
| Year select | 2420 | `onCalYearChange` 4881-4884 | **Wired for navigation, but data is not refetched.** `loadCalEvents()` fetches *all* events with no date filter (`server.js:3860`), so this works today only because the whole table is in memory. The code comments this explicitly at `views/app.html:4981-4984`. Options are rebuilt on every render (4925-4928), which resets any open dropdown. |
| Today | 2423 | `jumpToToday` 4886-4895 | **Fully wired** and does more than its label — it also *selects* today and opens the day panel (4892-4894). |
| Year toggle | 2424 | `toggleCalView` 4897-4900 | **Fully wired.** Button text is relabelled `Month`/`Year` by `syncCalHeader` (4930-4931). |
| `+ Add Event` (nav bar) | 2425 | `openAddEvent` 5520-5527 | **Wired**, but posts a date-only, `general`, all-day event — no time-of-day input exists in `#eventModal` (`submitAddEvent`, 5533-5545). |

No stubs found — every control's handler exists and executes. The two partial behaviours are (a) the year select not triggering a scoped refetch, and (b) `+ Add Event` having no time fields.

---

## 2. DATA FLOW

### 2.1 Every API endpoint the calendar page calls

**10 endpoints.**

| # | Method + path | Handler | Called from |
|---|---|---|---|
| 1 | `GET /api/calevents` | `server.js:3859-3862` | `loadCalEvents` (`views/app.html:5931`) |
| 2 | `POST /api/calevents` | `server.js:3864-3927` | `submitAddEvent` (5537), `submitBlockOff` (5193) |
| 3 | `GET /api/calevents/:id` | `server.js:3932-3984` | `openCalEventDetail` (5270), `calEventDetailSave` (5473) |
| 4 | `DELETE /api/calevents/:id` | `server.js:3992-4074` | `deleteCalEvent` (5215), `calEventDetailDelete` (5503) |
| 5 | `PATCH /api/appointments/:id` | `server.js:4083-4201` | `calEventDetailSave` (5461) |
| 6 | `GET /api/tasks` | `server.js:3723-3726` | `loadTasks` (5924) |
| 7 | `POST /api/tasks` | `server.js:3728-3744` | `submitAddEvent` (5540) |
| 8 | `PUT /api/tasks/:id` | `server.js:3746-3754` | `toggleTask` (5973) |
| 9 | `DELETE /api/tasks/:id` | `server.js:3770-3774` | `deleteTask` (5978) |
| 10 | `POST /api/daily-nudge/ensure` | `server.js:2503-2574` | `ensureDailyNudge` (5942) |

All requests go through `api()` (`views/app.html:4125-4131`) or raw `fetch`. `api()` returns `null` on any non-2xx (4129), which is why `loadCalEvents` has the `|| []` guard (5931).

#### Response shapes

**1. `GET /api/calevents`** — `SELECT * FROM cal_events WHERE user_id=$1 ORDER BY date ASC` (`server.js:3860`). Note: **`user_id`-scoped, not workspace-scoped**, and ordered by the TEXT `date` column. Columns are the initDB trio (`server.js:803-808`) plus the six added by migration 034.

```json
[
  { "id": 412, "user_id": 1, "date": "2026-07-20", "title": "Haircut — Dana Ruiz",
    "workspace_id": 3, "starts_at": "2026-07-20T14:00:00.000Z", "ends_at": "2026-07-20T14:30:00.000Z",
    "is_all_day": false, "event_type": "appointment", "appointment_id": 88 }
]
```

**2. `POST /api/calevents`** — `201` with `RETURNING *` (`server.js:3919-3926`); same shape as one element above.

**3. `GET /api/calevents/:id`** — `{event, appointment, contact}` (`server.js:3979`). `event` columns from the SELECT at `server.js:3940-3941`; `appointment` from `server.js:3953-3954`; `contact` from `server.js:3970`.

```json
{
  "event": { "id": 412, "workspace_id": 3, "title": "Haircut — Dana Ruiz", "date": "2026-07-20",
             "starts_at": "2026-07-20T14:00:00.000Z", "ends_at": "2026-07-20T14:30:00.000Z",
             "is_all_day": false, "event_type": "appointment", "appointment_id": 88 },
  "appointment": { "id": 88, "status": "confirmed", "duration_minutes": 30, "quoted_price_cents": 4500,
                   "notes_internal": null, "notes_customer": null, "source": "ai_inbound_sms",
                   "contact_id": 21, "cal_event_id": 412 },
  "contact": { "id": 21, "name": "Dana Ruiz", "phone": "+15551234567", "email": null }
}
```

`appointment` and `contact` are `null` for plain events and block-offs (`server.js:3949-3950`).

**4. `DELETE /api/calevents/:id`** — one of `{success:true, deleted:true}` (4019, 4036, 4069), `{success:true, cancelled:true}` (4061), or `{success:true, cancelled:true, alreadyCancelled:true}` (4042).

**5. `PATCH /api/appointments/:id`** — `{appointment: <full row>}` from `SELECT *` (`server.js:4192-4196`). Columns per `migrations/phase1-additive/035_appointments.sql:26-58`.

```json
{ "appointment": { "id": 88, "workspace_id": 3, "contact_id": 21, "cal_event_id": 412,
  "title": "Haircut — Dana Ruiz", "notes_internal": null, "notes_customer": null,
  "starts_at": "2026-07-20T14:00:00.000Z", "duration_minutes": 30, "ends_at": "2026-07-20T14:30:00.000Z",
  "status": "confirmed", "customer_confirmed": false, "reminder_sent_at": null,
  "quoted_price_cents": 4500, "final_price_cents": null, "amount_paid_cents": 0,
  "payment_method": null, "payment_collected_at": null, "source": "ai_inbound_sms",
  "created_by_user_id": 1, "ai_confidence_at_creation": null,
  "created_at": "2026-07-18T11:02:14.221Z", "updated_at": "2026-07-18T12:40:03.887Z",
  "canceled_at": null, "canceled_by": null, "canceled_reason": null, "completed_at": null } }
```

**6. `GET /api/tasks`** — `SELECT * FROM tasks WHERE user_id=$1 ORDER BY suggested DESC, "dueDate" ASC` (`server.js:3724`). Columns per `server.js:756-766`.

```json
[ { "id": 57, "user_id": 1, "title": "Order more toner", "category": "other",
    "dueDate": "2026-07-20", "notes": "Added from calendar.", "done": false,
    "suggested": false, "aiReason": "" } ]
```

**7. `POST /api/tasks`** — `201` with `RETURNING *` (`server.js:3739-3743`); same shape.
**8. `PUT /api/tasks/:id`** — the updated row, or `404 {error:'Task not found'}` (`server.js:3752-3753`).
**9. `DELETE /api/tasks/:id`** — `{success:true}` or `404` (`server.js:3772-3773`).
**10. `POST /api/daily-nudge/ensure`** — `{created:true, nudge:{id, title}}` (`server.js:2556-2570`), `{created:false, error:'generation_empty'}` (2545), or `500 {error:'daily_nudge_insert_failed'}` (2567).

### 2.2 How events get onto the grid

1. `loadCalEvents()` (`views/app.html:5930-5933`) calls `api('calevents')`, which `fetch`es `/api/calevents` (`views/app.html:4128`).
2. The handler runs `SELECT * FROM cal_events WHERE user_id=$1 ORDER BY date ASC` (`server.js:3860`) — **every event ever, unbounded, unfiltered by date**.
3. The array replaces the module-global `calEvents` (`views/app.html:5931`), which was seeded with three hard-coded demo rows at `views/app.html:3861-3865`.
4. `renderCalendar()` → `renderMonthView()` (`views/app.html:4937`).
5. The grid filter is a **string equality test against the legacy `date` TEXT column**:
   ```js
   const dayEvents = calEvents.filter(e => e.date === dateStr);
   ```
   (`views/app.html:4964`), where `dateStr` is built from `calYear`/`calMonth`/`d` as `YYYY-MM-DD` (4961). `starts_at`/`ends_at` are **not consulted at all** for grid placement.
6. Each matching event contributes one 6px dot, coloured `--text-muted` for `time_off` and `--accent` otherwise (`views/app.html:4968`). Tasks add `--info` dots (4969). No titles, no times, no ordering, no overlap handling.
7. The year view applies the same TEXT match via `String(e.date).startsWith(calYear + '-')` (`views/app.html:5006`).
8. The day panel applies the same TEXT match (`views/app.html:5054`) but *does* then read `starts_at` for the time prefix (5070) — so a row whose `date` and `starts_at` disagree lands on one day and displays another day's time.

### 2.3 CRITICAL: how does an SMS/AI-created appointment appear on the calendar?

**Answer: (a) manual refresh only.** There is no polling of calendar data and no live push.

Evidence:

- **No websocket, no SSE.** Grepping `views/app.html` for `WebSocket|EventSource|socket\.io` returns **zero matches**. The only `setInterval` calls in the file are `updateClock` every 1s (`views/app.html:4121`), the PS-home dashboard poll every 30s (`views/app.html:7107-7118`), and `pollInbox` every 10s (`views/app.html:8625`).
- **`pollInbox` does not touch the calendar.** On a change it sets `messages`, re-renders the inbox folder, updates badges and calls `loadHomeStats()` (`views/app.html:8615-8622`). It never calls `loadCalEvents()`.
- **The PS dashboard poll does not touch the calendar.** It only calls `loadPSDashboard()`, and only when the Home page is active (`views/app.html:7113-7117`).
- **`loadCalEvents()` runs on page load and after local mutations only** — `window.onload` (`views/app.html:8846`), `ensureDailyNudge` when it created a row (5949), and after the user's own create/edit/delete (5204, 5216, 5489, 5512, 5542).
- **`showPage('calendar')` does not refetch.** `showPage` (`views/app.html:3878-3926`) has explicit per-page refresh branches for `home`, `inventory`, `reports`, `finances`, `menu`, `inventory-ps`, `my-business` — **there is no `calendar` branch**, and it never calls `refreshPageData`. Clicking Calendar in the sidebar renders whatever is already in the `calEvents` array.
- **`refreshPageData('calendar')` exists** (`views/app.html:8270-8274`) but is only reached from the AI tool→page map (`views/app.html:8326-8336`), and `TOOL_PAGE_MAP` (`views/app.html:8225-8253`) maps only `add_calendar_event` and `delete_calendar_event` to `['calendar']`. **`book_appointment`, `update_appointment`, and `cancel_appointment` are absent from that map entirely** — so even an appointment booked through the in-browser command bar does not refresh the calendar.
- **The pending-action approval path skips the calendar too**: `refreshPageData('inbox')`, `('admin')`, `('home')` (`views/app.html:8033-8035`, `8093-8094`) — never `('calendar')`.
- The Command Center calls `refreshPageData()` with **no argument** (`views/app.html:12268`), so the `switch (pageName)` at `server`-side-mirroring `views/app.html:8261` matches no case and nothing is refreshed.

An appointment booked by the AI over SMS via `lib/tools/book_appointment.js:78-107` writes both rows server-side, but the browser only learns about it on a **full page reload** (`window.onload` → `loadCalEvents`, `views/app.html:8846`) or after the user performs their own calendar mutation.

---

## 3. DATA MODEL

### 3.1 `appointments`

There is no `CREATE TABLE appointments` in `server.js` — grepping `CREATE TABLE .*(appointments|cal_events|tasks|workspaces)` in `server.js` returns only `tasks` (line 756) and `cal_events` (line 803). The table is created entirely by `migrations/phase1-additive/035_appointments.sql:26-58`.

| Column | Type | Source |
|---|---|---|
| `id` | `SERIAL PRIMARY KEY` | 035:27 |
| `workspace_id` | `INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE` | 035:28 |
| `contact_id` | `INTEGER` (nullable, soft FK to user-scoped contacts) | 035:29 |
| `cal_event_id` | `INTEGER REFERENCES cal_events(id) ON DELETE SET NULL` | 035:30 |
| `title` | `TEXT NOT NULL` | 035:32 |
| `notes_internal` | `TEXT` | 035:33 |
| `notes_customer` | `TEXT` | 035:34 |
| `starts_at` | `TIMESTAMPTZ NOT NULL` | 035:36 |
| `duration_minutes` | `INTEGER NOT NULL DEFAULT 60` | 035:37 |
| `ends_at` | `TIMESTAMPTZ NOT NULL` | 035:38 |
| `status` | `TEXT NOT NULL DEFAULT 'requested'` | 035:40 |
| `customer_confirmed` | `BOOLEAN DEFAULT FALSE` | 035:41 |
| `reminder_sent_at` | `TIMESTAMPTZ` | 035:42 |
| `quoted_price_cents` | `INTEGER` | 035:44 |
| `final_price_cents` | `INTEGER` | 035:45 |
| `amount_paid_cents` | `INTEGER DEFAULT 0` | 035:46 |
| `payment_method` | `TEXT` | 035:47 |
| `payment_collected_at` | `TIMESTAMPTZ` | 035:48 |
| `source` | `TEXT NOT NULL DEFAULT 'staff_command_bar'` | 035:50 |
| `created_by_user_id` | `INTEGER REFERENCES users(id) ON DELETE SET NULL` | 035:51 |
| `ai_confidence_at_creation` | `NUMERIC(3,2)` | 035:52 |
| `created_at` | `TIMESTAMPTZ DEFAULT NOW()` | 035:54 |
| `updated_at` | `TIMESTAMPTZ DEFAULT NOW()` | 035:55 |
| `canceled_at` | `TIMESTAMPTZ` | 035:56 |
| `canceled_by` | `TEXT` | 035:57 |
| `canceled_reason` | `TEXT` | 035:58 |
| `completed_at` | `TIMESTAMPTZ` | 035:59 |

Constraints: `status IN ('requested','confirmed','in_progress','completed','canceled','no_show')` (035:65); `source IN ('ai_inbound_sms','ai_inbound_email','ai_inbound_voicemail','staff_command_bar','public_booking','walk_in')` (035:74-75). Indexes at 035:78-81. No further migration in `migrations/phase1-additive/*.sql` adds columns to `appointments`.

### 3.2 `cal_events`

Base table in `server.js:803-808`:

```sql
CREATE TABLE IF NOT EXISTS cal_events (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 1,
  date TEXT,
  title TEXT
)
```

Plus `ALTER TABLE cal_events ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 1` (`server.js:810`).

Extended by `migrations/phase1-additive/034_calendar_extension.sql:26-31`:

| Column | Type | Source |
|---|---|---|
| `id` | `SERIAL PRIMARY KEY` | `server.js:804` |
| `user_id` | `INTEGER NOT NULL DEFAULT 1` | `server.js:805` |
| `date` | `TEXT` | `server.js:806` |
| `title` | `TEXT` | `server.js:807` |
| `workspace_id` | `INTEGER REFERENCES workspaces(id) ON DELETE CASCADE` | 034:26 |
| `starts_at` | `TIMESTAMPTZ` | 034:27 |
| `ends_at` | `TIMESTAMPTZ` | 034:28 |
| `is_all_day` | `BOOLEAN DEFAULT TRUE` | 034:29 |
| `event_type` | `TEXT DEFAULT 'general'` | 034:30 |
| `appointment_id` | `INTEGER` | 034:31; upgraded to `FOREIGN KEY … REFERENCES appointments(id) ON DELETE SET NULL` by 035:88-89 |

Constraint: originally `event_type IN ('general','appointment','time_off','personal')` (034:63), widened to include `'daily_focus'` by `migrations/phase1-additive/040_cal_events_daily_focus.sql:32-33`.

Backfill (034:36-53): `workspace_id` from `workspaces.owner_user_id`; `starts_at = (date::date)::timestamptz`, `ends_at = ((date::date) + INTERVAL '1 day')::timestamptz`, `is_all_day = TRUE`, only for rows whose `date` matches `^\d{4}-\d{2}-\d{2}$`. **Rows with free-form `date` values keep `starts_at = NULL`** (034:87-91 counts them).

Indexes: `idx_cal_events_workspace_starts_at` (034:68-69), `idx_cal_events_appointment_id` (034:71-72), `idx_cal_events_daily_focus` (040:37-39).

### 3.3 Where cancellations are represented

Two places, inconsistently:

- **`appointments.status = 'canceled'`** plus `canceled_at`, `canceled_by`, `canceled_reason` (`migrations/phase1-additive/035_appointments.sql:56-58`), written by `server.js:4044-4052` and `lib/tools/cancel_appointment.js:43-54`. This is a **soft cancel** — the row persists.
- **`cal_events` row deletion.** The linked calendar row is hard-deleted (`server.js:4054-4060`, `lib/tools/cancel_appointment.js:56-60`). There is no separate cancellations table.

Consequence: a cancelled appointment is fully queryable in `appointments` but **invisible on the calendar**, because the calendar reads only `cal_events` (`server.js:3860`).

### 3.4 Where no-shows are represented

`'no_show'` is a legal value of `appointments.status` per the CHECK constraint (`migrations/phase1-additive/035_appointments.sql:65`), and two server queries exclude it from availability/conflict logic (`server.js:2362`, `server.js:6248`) — plus one comment in `lib/payment-ledger.js:169`.

**But nothing writes it.** Grepping `no_show|noShow` across `*.js|*.html|*.sql` returns only those four sites plus the constraint. There is no UI control, no endpoint, and no AI tool that sets `status='no_show'`. **No-show is effectively unrepresented in practice** — the column can hold it, but no code path produces it.

### 3.5 Recurring appointments

**No recurring-appointment support exists.** Grepping `recur|rrule|repeat` (case-insensitive) across `*.js`, `*.html`, `*.sql` returns only: the JS `String.prototype.repeat` method (`views/app.html:4522`, `scripts/*.js`), CSS `repeat(7, 1fr)` grid declarations (`views/app.html:435, 487`, etc.), prose uses of "repeat"/"recurring" in marketing copy (`public/features/maintenance.html:134, 195, 201`) and code comments (`server.js:326`, `server.js:2034`). There is no `rrule` column, no recurrence table, no expansion logic. Every appointment and every `cal_events` row is a single standalone instance.

### 3.6 CRITICALLY: how date and time are stored

| Column | Type | UTC or local? | Where conversion happens |
|---|---|---|---|
| `appointments.starts_at` | `TIMESTAMPTZ` (035:36) | Stored as an absolute instant. Always written as a UTC ISO string. | **Node.** `toZonedISO(...)` in `book_appointment.js:64`, `server.js:4130`, `update_appointment.js`. The value passed to Postgres is `.toISOString()` (`book_appointment.js:84`). |
| `appointments.ends_at` | `TIMESTAMPTZ` (035:38) | Same. | **Node**, always derived arithmetically: `start + duration_minutes*60*1000` (`book_appointment.js:69`, `server.js:4144`). Never independently parsed. |
| `appointments.created_at` / `updated_at` / `canceled_at` / `completed_at` / `reminder_sent_at` / `payment_collected_at` | `TIMESTAMPTZ` (035:42, 48, 54-59) | Absolute. | **Database** — `DEFAULT NOW()` / `SET … = NOW()` (`server.js:4047, 4050`). |
| `cal_events.starts_at` | `TIMESTAMPTZ` (034:27) | Absolute. | **Node** — `toZonedISO(\`${date}T${start_time}:00\`, tz)` (`server.js:3899-3900`, `add_calendar_event.js:83-84`), or all-day midnight `toZonedISO(\`${date}T00:00:00\`, tz)` (`server.js:3913`). **Exception:** `POST /api/daily-nudge/ensure` bypasses the helper and hardcodes UTC midnight — `new Date(today + 'T00:00:00.000Z')` (`server.js:2550`). |
| `cal_events.ends_at` | `TIMESTAMPTZ` (034:28) | Absolute. | **Node** — either the second `toZonedISO` call, or `starts_at + 24h` in raw milliseconds (`server.js:3915`, `server.js:2551`), which is **not** DST-aware: a 24h add across a transition lands at 23:00 or 01:00 local, not midnight. |
| `cal_events.date` | **`TEXT`** (`server.js:806`) | **Neither** — a bare `YYYY-MM-DD` string with no zone semantics. This is the column the grid actually filters on (`views/app.html:4964`). | Written variously: verbatim from client input (`server.js:3924`, `add_calendar_event.js:109`), or derived as **UTC** via `startsAtDate.toISOString().slice(0, 10)` (`book_appointment.js:100`, `server.js:4183`, `update_appointment.js:109`). |
| `cal_events.is_all_day` | `BOOLEAN DEFAULT TRUE` (034:29) | n/a | Set by Node: `false` only when both `start_time` and `end_time` were supplied (`server.js:3909`); otherwise the default `TRUE` path runs (`server.js:3896`). |
| `tasks."dueDate"` | **`TEXT`** (`server.js:761`) | Neither — bare `YYYY-MM-DD`. | Never converted. Written straight from the client (`server.js:3741, 3750`) or as `new Date().toISOString().split('T')[0]` for the +7-day default (`server.js:3736-3737`) — a **UTC** date. |
| `workspaces.timezone` | `TEXT`, nullable, no default (`migrations/phase1-additive/046_workspace_timezone.sql:24`) | IANA name, e.g. `America/New_York`. | Read by `wsTz()`. |

#### Tracing `lib/time-helpers.js`

`wsTz(workspace)` — `lib/time-helpers.js:28-30` — returns `workspace.timezone` or the `DEFAULT_TZ = 'America/New_York'` constant (line 26). A NULL column silently becomes Eastern.

`toZonedISO(input, tz)` — `lib/time-helpers.js:60-85`:
- If the string ends in `Z` or `±HH:MM`/`±HHMM`, it is parsed as-is and normalized with `.toISOString()` (lines 66-70).
- Otherwise `parseNaive` (lines 34-39) matches `YYYY-MM-DD[T ]HH:mm[:ss]` and the wall-clock fields are interpreted **in `tz`** via the two-pass offset technique (lines 75-84).
- Returns `null` on unparseable input (lines 61-63, 74).

**Call sites of `wsTz`/`toZonedISO`:**

| File:line | Purpose |
|---|---|
| `server.js:3887-3891` | `POST /api/calevents` — loads `workspaces.timezone`, defaults via `wsTz(null)` when there is no workspace. |
| `server.js:3899-3900`, `3913` | `POST /api/calevents` — converts `date`+`start_time`/`end_time`, and the all-day midnight fallback. |
| `server.js:4108`, `4130` | `PATCH /api/appointments/:id` — interprets the client's naive `starts_at`. |
| `lib/tools/book_appointment.js:16, 64, 131` | Interprets `starts_at`; line 131 formats the confirmation string with `timeZone: wsTz(ctx.workspace)`. |
| `lib/tools/update_appointment.js:7` | Same, for reschedules. |
| `lib/tools/propose_appointment_times.js:42-46` | Builds the 9 AM–6 PM day window as workspace wall-clock (`DEFAULT_DAY_START_HOUR = 9`, `DEFAULT_DAY_END_HOUR = 18`, lines 11-12). |
| `lib/tools/add_calendar_event.js:29, 77, 83-84, 97` | Same conversion as the REST endpoint. |
| Per `046_workspace_timezone.sql:12-14` | `lib/appointment-engine.buildSystemPrompt` also reads it to render "## Upcoming calendar" in local time. |

**Not called by:** `POST /api/daily-nudge/ensure` (`server.js:2548-2551` hardcodes UTC midnight), and **nothing in `views/app.html`** — the browser has no access to `workspaces.timezone` at all.

#### What happens across a daylight-saving boundary

The two-pass technique at `lib/time-helpers.js:80-83` computes the offset once against the naive wall time treated as UTC (`off1`), forms a first guess, then recomputes the offset **at the guessed instant** (`off2`) and uses that. It converges for normal times but has defined-but-arbitrary behaviour at the two singular hours. Concretely, for `tz = 'America/New_York'`:

- **Fall back — 2026-11-01, 01:30 (ambiguous, occurs twice).** `wallAsUtc = 2026-11-01T01:30Z`. `off1` = offset at that instant (= Oct 31 21:30 EDT) = `-240`. `guess = 05:30Z`. `off2` = offset at `05:30Z` (= 01:30 EDT, still before the 06:00Z transition) = `-240`. Result: `05:30Z` — the **first** (EDT) of the two 1:30 AMs. The 1:30 AM EST occurrence (`06:30Z`) is **unreachable** through this code path. Two genuinely distinct appointments an hour apart collapse onto the same stored instant.
- **Spring forward — 2026-03-08, 02:30 (nonexistent).** `wallAsUtc = 02:30Z`. `off1` = offset at `02:30Z` (= Mar 7 21:30 EST) = `-300`. `guess = 07:30Z`. `off2` = offset at `07:30Z` (= 03:30 EDT, after the 07:00Z transition) = `-240`. Result: `06:30Z`, which is **01:30 AM EST** — the input time is silently shifted an hour *backwards* rather than rejected. A customer told "2:30" gets an appointment stored as 1:30.

Two further DST hazards, both outside `time-helpers`:
- All-day `ends_at` is computed as `starts_at + 24 * 60 * 60 * 1000` (`server.js:3915`, `server.js:2551`). On a spring-forward day that lands at 01:00 the next local day; on a fall-back day at 23:00 the same local day. The all-day block therefore does not align with the local calendar day it claims to cover.
- `ends_at` for appointments is `starts_at + duration_minutes` in raw ms (`server.js:4144`, `book_appointment.js:69`), which is correct for elapsed time but means a 60-minute appointment starting at 01:30 on fall-back day ends at a wall-clock time 2 hours later.

#### Browser-side rendering: browser-local, NOT workspace timezone

This distinction is the sharpest one in the codebase. **Every** client-side time format uses the browser's zone:

| Site | Code | Zone used |
|---|---|---|
| `renderDayDetail` time prefix | `new Date(e.starts_at).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit', hour12:true })` (`views/app.html:5070`) | **browser-local** — no `timeZone` option |
| `renderDayDetail` header label | `new Date(dateStr + 'T00:00:00')` then `toLocaleDateString` (`views/app.html:5052-5053`) | **browser-local** midnight |
| `_calFormatDate` | `views/app.html:5235` | **browser-local** |
| `_calFormatTime` | `views/app.html:5242` | **browser-local** |
| `_calSplitLocalDateTime` | `d.getFullYear()/getMonth()/getDate()` + `getHours()/getMinutes()` (`views/app.html:5373-5374`) | **browser-local**, and the source comment at 5362-5365 states this explicitly: *"Uses the browser's zone … a future refinement could format in the workspace tz."* |
| `renderMonthView` today marker | `new Date()` + `getFullYear/getMonth/getDate` (`views/app.html:4953-4954`) | **browser-local** |
| `renderYearView` today marker | `views/app.html:4988-4989` | **browser-local** |

Contrast with the server, which *does* use the workspace zone — `book_appointment.js:131` passes `{ timeZone: wsTz(ctx.workspace), … }` when formatting the SMS confirmation. So the customer's SMS and the owner's calendar screen can state different times for the same appointment whenever the owner's device zone differs from `workspaces.timezone` (travelling owner, a business whose zone is set differently from the staff device, or any workspace where `timezone` is NULL and defaults to Eastern while the browser is not).

The round-trip in `calEventDetailEdit` → `calEventDetailSave` makes this lossy: `_calSplitLocalDateTime` renders the stored instant into **browser-local** date/time inputs (`views/app.html:5386`), the user saves, and `PATCH` re-interprets those same digits as **workspace wall-clock** via `toZonedISO` (`server.js:4130`). Opening the Edit form and pressing Save without touching anything **shifts the appointment** by the difference between the two zones.

---

## 4. BLOCK-OFF & TASKS

### 4.1 Block-off — what exists today

A complete, recently added feature.

**UI** — `#blockOffModal`, `views/app.html:12856-12890`:

| Lines | Element |
|---|---|
| 12856 | `.modal-overlay#blockOffModal`, backdrop click → `closeBlockOffModal()`. Note: **no `style="display:none"`** inline, unlike `#calEventDetailModal` (3780) — visibility relies on the `.modal-overlay` class default. |
| 12858-12859 | Heading "🚫 Block off time" and the copy "Customers cannot be booked during blocked-off time." |
| 12861-12862 | `<input type="date" id="blockOffDate">` |
| 12864-12867 | `<input type="checkbox" id="blockOffWholeDay" checked onchange="onBlockOffWholeDayChange()">` |
| 12869-12878 | `#blockOffTimeRow` (hidden by default) with `#blockOffStart` and `#blockOffEnd` `<input type="time">` |
| 12880-12881 | `<input id="blockOffLabel" placeholder="Time off">` |
| 12883 | `#blockOffError` |
| 12885-12888 | Cancel → `closeBlockOffModal()`, `#blockOffSaveBtn` → `submitBlockOff()` |

**Entry point**: the `🚫 Block off time` button in the day-detail panel (`views/app.html:5115`). This is the **only** entry point — there is no block-off control in the `.cal-nav` bar (2417-2426).

**JS**:
- `openBlockOffTime(dateStr)` — `views/app.html:5143-5152`. Prefills the date, checks whole-day, clears the times/label/error, calls `onBlockOffWholeDayChange()`, shows the modal.
- `onBlockOffWholeDayChange()` — `views/app.html:5158-5164`. Toggles `#blockOffTimeRow` between `none`/`flex` and sets the `disabled` property on both time inputs.
- `submitBlockOff()` — `views/app.html:5166-5212`. Client-side validation: date required (5175), both times required when not whole-day (5176-5179), `start_time >= end_time` rejected by **string** comparison (5180-5183) — valid for zero-padded `HH:MM`. Body is `{date, title, event_type:'time_off'}` plus `start_time`/`end_time` when partial (5185-5186). Title defaults to `'Time off'` (5171). Posts to `/api/calevents` (5193-5197), then `closeBlockOffModal()` + `loadCalEvents()` + `renderDayDetail(selectedDate)` (5203-5205). Button is disabled and relabelled "Saving..." during the request (5189-5191, 5209-5210).
- `closeBlockOffModal()` — `views/app.html:5154-5156`.

**Endpoint** — `POST /api/calevents`, `server.js:3864-3927`:
- `event_type` whitelist is `['general', 'time_off', 'personal']` (`server.js:3873`); `'appointment'` is deliberately excluded so only `book_appointment.js` creates linked rows (`server.js:3870-3872`).
- Both-or-neither validation on `start_time`/`end_time` (`server.js:3879-3881`).
- Timezone: loads `workspaces.timezone`, falls back through `wsTz(null)` (`server.js:3888-3892`).
- Partial block: `starts_at`/`ends_at` via `toZonedISO`, `is_all_day = false` (`server.js:3898-3909`).
- Whole-day block: `starts_at = toZonedISO(\`${date}T00:00:00\`, tz)`, `ends_at = starts_at + 24h`, `is_all_day` stays `true` (`server.js:3910-3917`).
- Insert writes `user_id`, `workspace_id`, `date`, `title`, `starts_at`, `ends_at`, `is_all_day`, `event_type` (`server.js:3919-3925`).

**Rendering**: `time_off` events get a `--text-muted` dot on the month grid (`views/app.html:4968`), a `'gray'` mini-dot in the year view unless the day also has a real event (`views/app.html:5007-5008`), a muted row with a 🚫 icon in the day panel (`views/app.html:5076-5079`), and a muted "TIME OFF" badge in the detail modal (`views/app.html:5307-5311`). Deleting one takes the plain-event hard-delete path (`server.js:4064-4068`) since `appointment_id` is NULL.

**How the appointment engine treats it** — `lib/tools/propose_appointment_times.js`:

```sql
SELECT starts_at, ends_at, is_all_day FROM cal_events
 WHERE workspace_id = $1 AND starts_at < $2 AND ends_at > $3 ORDER BY starts_at ASC
```
(`lib/tools/propose_appointment_times.js:53-59`). Two things follow:

1. **All `cal_events` rows block availability regardless of `event_type`.** The query does not filter on `event_type` at all — a `general` event, a `personal` event, and the `daily_focus` nudge block time exactly as hard as a `time_off` row. `lib/tools/add_calendar_event.js:19` documents this explicitly: *"all cal_events as busy (propose_appointment_times.js:44-67)"*.
2. **Any `is_all_day` row blocks the entire day**, short-circuiting slot generation: `if (events.rows.some((e) => e.is_all_day)) return { … slots: [] … '${target_date} is fully blocked.' }` (`lib/tools/propose_appointment_times.js:61-63`). Since the **daily-focus nudge is inserted as `is_all_day: TRUE` every single day** (`server.js:2559`), this branch fires unconditionally on any day the nudge exists.

Slot generation walks the 9 AM–6 PM window (lines 11-12, 43-46) in `SLOT_GRANULARITY_MINUTES` steps testing half-open overlap `cursor < eEnd && cursor + durationMs > eStart` (`lib/tools/propose_appointment_times.js:68-78`). Rows with `starts_at IS NULL` — the unparseable-date rows migration 034 skipped (034:87-91) — are invisible to the `starts_at < $2 AND ends_at > $3` predicate and block nothing.

### 4.2 Tasks

**Storage** — `tasks`, `server.js:756-766`:

| Column | Type | Line |
|---|---|---|
| `id` | `SERIAL PRIMARY KEY` | 757 |
| `user_id` | `INTEGER NOT NULL DEFAULT 1` | 758 |
| `title` | `TEXT` | 759 |
| `category` | `TEXT` | 760 |
| `"dueDate"` | `TEXT` | 761 |
| `notes` | `TEXT` | 762 |
| `done` | `BOOLEAN DEFAULT false` | 763 |
| `suggested` | `BOOLEAN DEFAULT false` | 764 |
| `"aiReason"` | `TEXT DEFAULT ''` | 765 |

Idempotent re-adds at `server.js:768-770`. Two seed rows are inserted for `user_id=1` when the table is empty (`server.js:772-777`). No migration in `migrations/phase1-additive/*.sql` touches `tasks`.

**The `dueDate` column** is `TEXT`, **not** `DATE` or `TIMESTAMPTZ` (`server.js:761`), and it is **quoted camelCase** — every reference must write `"dueDate"` or Postgres will fold it to `duedate` and fail. Live examples: `ORDER BY suggested DESC, "dueDate" ASC` (`server.js:3724`), `INSERT INTO tasks (…, "dueDate", …)` (`server.js:3740`), `UPDATE tasks SET … "dueDate"=$4 …` (`server.js:3749`). The same quoting applies to `"aiReason"` (765, 3740). Because it is TEXT there is no date validation, no index-friendly range query, and no timezone semantics — the +7-day default is `new Date().toISOString().split('T')[0]` (`server.js:3736-3737`), i.e. the **UTC** date.

**Fetching**:
- Endpoint: `GET /api/tasks` — `server.js:3723-3726`, `SELECT * FROM tasks WHERE user_id=$1 ORDER BY suggested DESC, "dueDate" ASC`. **`user_id`-scoped, not workspace-scoped.**
- JS: `loadTasks()` — `views/app.html:5923-5928` — fills the global `tasks` (declared at 5920) and then calls `renderTasks()`, `updateTaskBadge()`, and `renderCalendar()`.
- Calendar consumption: month grid `tasks.filter(t => !t.done && t.dueDate === dateStr)` (`views/app.html:4965`) → one `--info` dot each (4969); day panel `tasks.filter(t => t.dueDate === dateStr)` (`views/app.html:5055`) — **no `!t.done` filter**, so completed tasks appear in the panel but not on the grid.
- Mutations from the calendar: `toggleTask` → `PUT /api/tasks/:id` (`views/app.html:5973`, `server.js:3746-3754`), `deleteTask` → `DELETE /api/tasks/:id` (`views/app.html:5978`, `server.js:3770-3774`), and `openAddTaskOnDate` which **leaves the calendar page entirely** for the Tasks page (`views/app.html:5130-5136`, prefilling `#taskDueDate` at 2710).
- `toggleTask` sends `{...t, done: !t.done}` (`views/app.html:5973`) while the handler destructures `{done, title, category, dueDate, notes}` and writes all five unconditionally (`server.js:3747-3751`) — a task with any field absent from the in-memory object would have it nulled.

---

## 5. MOBILE

There are six media queries in `views/app.html`. Only one contains calendar-specific rules.

| Lines | Query | Calendar-specific content |
|---|---|---|
| 334-340 | `@media (max-width: 768px)` | **None.** Collapses `.asymmetric-2col` / `.asymmetric-1-1` to one column (335-338). The calendar's two-column shell uses neither class — it is an inline `display:flex` at `views/app.html:2412`, so this rule does not apply to it. |
| 1396-1471 | `@media (max-width: 768px)` | **The only calendar rules in the file**, at 1449-1451: `.cal-day { min-height: 50px; font-size: 0.78em; padding: 4px; }` (1450) and `.cal-nav button { padding: 7px 10px; font-size: 0.82em; }` (1451). Also relevant indirectly: `#content { padding: 16px 14px; }` (1422), `.card { padding: 16px 16px; }` (1425), `.modal { width: 95vw; padding: 22px 18px; }` (1461) — which does apply to `#calEventDetailModal` (3781) and `#blockOffModal` (12857) — and `.modal .modal-footer { flex-wrap: wrap; }` (1467) for the block-off footer (12885). |
| 1473-1478 | `@media (max-width: 480px)` | **None.** Home stat grid (1475), `.card h2` (1476), `#topbar` (1477) only. |
| 1660-1666 | `@media (max-width: 767px)` | **None.** Command Center `.cc-*` only (1661-1665). |
| 1853-1862 | `@media (min-width: 768px)` | **None.** PS dashboard `.ps-*` only. |
| 1865-1873 | `@media (min-width: 1024px)` | **None.** PS dashboard max-width centring only. |

**What this means in practice on a narrow screen:**

- The 7-column grid is **never collapsed**. `.calendar-grid { grid-template-columns: repeat(7, 1fr); }` (`views/app.html:435`) holds at every width; the only concession is shrinking cells to `min-height: 50px` (1450). At 375px that is roughly 49px per column minus the 4px gaps (436).
- The **day-detail sidebar never stacks**. Its `width:300px;flex-shrink:0` is an inline style (`views/app.html:2433`) inside an inline `display:flex` (2412), and no media query overrides either. On a 375px viewport the sidebar consumes 300px and the calendar grid is squeezed into the remainder.
- The year view uses `grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))` (`views/app.html:473`), which does reflow to a single mini-month column below ~220px of available width — the only auto-responsive calendar rule. Mini-day cells stay at `font-size: 0.72em` with `padding: 4px 0 6px` (`views/app.html:490-492`) with no mobile override.
- `.cal-nav` has `flex-wrap: wrap` (`views/app.html:457`), so the seven controls (2418-2425) wrap onto multiple rows rather than overflowing.
- Tap targets: `.cal-mini-day` at ~0.72em with 4-6px padding (`views/app.html:489-497`) and the day-panel `✕`/`✓` spans with `padding: 0 4px` / `0 2px` (`views/app.html:5082, 5093`) are well under the 44px minimum that the Command Center block explicitly targets (comment at `views/app.html:1659`).
- `.page { padding-bottom: 88px; }` (`views/app.html:1490`) reserves space for the fixed Command Center on the calendar page like every other page.

---

## 6. GAPS & RISKS

*This section is the only place in this document containing opinion or recommendation.*

**1. The calendar never learns about server-side changes — the single biggest functional gap.**
No websocket, no SSE, and no calendar polling exist (`views/app.html` has zero `WebSocket`/`EventSource` matches; the three `setInterval`s at 4121, 7109, and 8625 refresh the clock, the PS home dashboard, and the inbox respectively). Worse, the refresh hooks that *do* exist skip the calendar: `showPage` has no `calendar` branch (`views/app.html:3878-3926`), `TOOL_PAGE_MAP` omits `book_appointment`/`update_appointment`/`cancel_appointment` (`views/app.html:8225-8253`), the pending-action approval path refreshes only inbox/admin/home (`views/app.html:8033-8035`), and the Command Center calls `refreshPageData()` with no argument so the switch matches nothing (`views/app.html:12268`). For a product whose headline is "the AI books appointments over SMS", the owner's calendar is stale until they hard-reload the tab. I would treat live-or-polled refresh as a P0 requirement of the rebuild, and I would add the appointment tools to `TOOL_PAGE_MAP` regardless of which mechanism is chosen.

**2. Dual source of truth for *when*: the legacy `date` TEXT column drives rendering while `starts_at TIMESTAMPTZ` drives booking logic — and they are derived differently.**
The grid filters `e.date === dateStr` (`views/app.html:4964`, and the same match at 5006 and 5054), but availability uses `starts_at`/`ends_at` (`lib/tools/propose_appointment_times.js:53-59`). The two are populated from different computations: `book_appointment.js:100` writes `date` as `startsAtDate.toISOString().slice(0, 10)` — the **UTC** date — while `starts_at` is a correctly zone-converted instant. **A 8:00 PM Eastern appointment is `00:00Z` the next day, so `date` lands on tomorrow and the event renders on the wrong calendar cell.** The identical bug exists in `server.js:4183` and `lib/tools/update_appointment.js:109`. Every evening appointment in a western timezone is misplaced by one day today. I would make `starts_at` the sole rendering source in the rebuild and treat `date` as write-only legacy, or drop it.

**3. Browser-local rendering vs. workspace-timezone storage, with a lossy edit round-trip.**
Every client formatter omits the `timeZone` option — `views/app.html:5070`, `5235`, `5242`, and `_calSplitLocalDateTime` uses `getHours()`/`getDate()` (`views/app.html:5373-5374`, with the source comment at 5362-5365 conceding the point). Meanwhile the server formats the customer's SMS with `timeZone: wsTz(ctx.workspace)` (`lib/tools/book_appointment.js:131`). The concrete failure: opening Edit and pressing Save without changing anything shifts the appointment, because `_calSplitLocalDateTime` writes browser-local digits into the inputs (`views/app.html:5386`) and `PATCH` re-reads them as workspace wall-clock through `toZonedISO` (`server.js:4130`). The rebuild should push `workspaces.timezone` to the client and format everything with an explicit `timeZone`.

**4. The month grid cannot render overlapping events — or event content at all.**
`renderMonthView` emits one 6px dot per event into a `flex-wrap` div (`views/app.html:4966-4971`); there is no title, no time, no sort, no overlap geometry, and no `+N more` overflow. Two appointments at 2:00 PM and two at 3:00 PM are four identical dots. Google-Calendar-standard layout requires positioned, time-sorted, collision-resolved blocks — this is a from-scratch build, not an enhancement. Note also that the grid is assembled by `innerHTML +=` inside the day loop (`views/app.html:4957`, `4972`), which reparses the entire grid on every iteration; at 42 cells this is already wasteful and will not survive per-event DOM.

**5. Multi-day and midnight-spanning events have no representation.**
Placement is a single-string equality on `date` (`views/app.html:4964`), so an event is on exactly one day by construction. An appointment from 11:30 PM to 12:30 AM appears only on its start date with no continuation, and `renderDayDetail` will show it under a time prefix derived from `starts_at` (`views/app.html:5070`) that may not match the cell it was clicked from. Any rebuild that wants Google-Calendar semantics needs range-based placement, which means the `date`-column dependency (risk 2) must be removed first.

**6. All-day semantics are inconsistent across three writers, and the daily-focus nudge blocks the entire booking day.**
`POST /api/calevents` computes all-day as workspace-local midnight + 24h in raw milliseconds (`server.js:3913-3916`); migration 034 backfilled it as `(date::date)::timestamptz` in the *database server's* zone (034:47-48); and `POST /api/daily-nudge/ensure` bypasses `time-helpers` entirely with `new Date(today + 'T00:00:00.000Z')` (`server.js:2550`). Three different notions of "midnight" coexist in one column. The operational consequence is severe: `propose_appointment_times.js:61-63` returns *zero slots* and the message "is fully blocked" for **any** day containing an `is_all_day` row, and the daily-focus nudge inserts exactly such a row every day (`server.js:2559`). Unless something else suppresses it, the AI cannot propose a single time slot on any day the nudge exists. I would verify this against the live database before the rebuild, because if it reproduces it is a live outage of the booking flow, not a rebuild concern.

**7. `event_type` is ignored by availability, so ordinary calendar events silently block bookings.**
The conflict query selects all `cal_events` for the workspace with no `event_type` predicate (`lib/tools/propose_appointment_times.js:53-59`), a behaviour `lib/tools/add_calendar_event.js:19` documents as intentional. That makes the block-off feature (Section 4.1) semantically redundant — a `general` event blocks exactly as hard as a `time_off` one — while the UI presents block-off as the dedicated mechanism ("Customers cannot be booked during blocked-off time", `views/app.html:12859`). Adding tasks to the calendar will make this worse if tasks ever gain `cal_events` rows.

**8. Cancelled appointments vanish from the calendar entirely, destroying the audit trail on the surface where it matters.**
The status soft-cancel is careful and complete (`server.js:4044-4052`), but the linked `cal_events` row is then hard-deleted (`server.js:4054-4060`, mirroring `lib/tools/cancel_appointment.js:56-60`). The owner has no way to see that a slot *was* booked and got cancelled. Relatedly, `no_show` is a legal status (`migrations/phase1-additive/035_appointments.sql:65`) that **no code path ever writes** — it is read-only dead weight in the constraint, excluded by `server.js:2362` and `server.js:6248` but never set. If the rebuild wants a cancelled/no-show visual state, both need new write paths.

**9. Scoping is inconsistent between the calendar's list endpoint and its detail endpoints — a probable multi-tenant leak.**
`GET /api/calevents` is `user_id`-scoped and fetches the **entire unbounded table** with no date filter (`server.js:3860`), as is `GET /api/tasks` (`server.js:3724`). But `GET /api/calevents/:id` (`server.js:3943`), `DELETE` (`server.js:4003`), and `PATCH /api/appointments/:id` (`server.js:4094`) are all `workspace_id`-scoped, with an explicit legacy `user_id` fallback in the delete path (`server.js:4013-4020`). In a multi-user workspace the list and the detail views disagree about what the user can see. The unbounded fetch is also why the year dropdown appears to work without a refetch (`views/app.html:4979-4984`) — that convenience will break the moment the list is correctly date-scoped, so the rebuild must add year/month-scoped loading and fix the scoping together.

**10. Coupling: the calendar page reaches into the Tasks page's DOM, and shares mutable globals with the AI command bar.**
`openAddTaskOnDate` navigates away via `showPage('tasks', …)`, hand-manipulates sidebar `.active` classes, and writes directly into `#taskDueDate` (`views/app.html:5130-5136`, input at 2710) — so the "+ Add Task" button on the calendar breaks if the Tasks page markup changes. In the other direction, `loadTasks()` calls `renderCalendar()` (`views/app.html:5927`), so any task mutation anywhere re-renders the calendar; and both `calEvents` and `tasks` are shipped wholesale into the AI request body (`views/app.html:8423-8424`) and the report body (`views/app.html:8510`). The globals are also pre-seeded with three hard-coded 2026 demo events (`views/app.html:3861-3865`) that render until the first successful fetch — and persist forever if `api()` returns `null` on an error (`views/app.html:4129`, guarded by `|| []` at 5931). Any rebuild that changes the shape of `calEvents` must audit all five consumers.
