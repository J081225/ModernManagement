# Tool Parity Audit

Governing principle under test: **anything an owner can do by clicking, they can do by asking.**

Scope: `views/app.html` (14,256 lines), `lib/tools/*.js` (53 registered tools), `lib/tool-registry.js`, `lib/appointment-engine.js`, `server.js` (8,521 lines).

---

## 1. UI ACTION INVENTORY

The SPA's screens are `<div class="page" id="page-*">` blocks. Enumerated:

| # | Screen id | Line | Notes |
|---|---|---|---|
| 1 | `page-home` | `views/app.html:2235` | Splits into `page-home-pm` (`:2239`) and `page-home-ps` (`:2406`) |
| 2 | `page-inbox` | `views/app.html:2482` | |
| 3 | `page-operations` | `views/app.html:2536` | Automation + email-connect + knowledge base |
| 4 | `page-calendar` | `views/app.html:2705` | |
| 5 | `page-reports` | `views/app.html:2758` | |
| 6 | `page-contacts` | `views/app.html:2804` | |
| 7 | `page-inventory` | `views/app.html:2876` | PM properties/units |
| 8 | `page-tasks` | `views/app.html:2941` | |
| 9 | `page-maintenance` | `views/app.html:3054` | |
| 10 | `page-admin` | `views/app.html:3094` | Settings + rent + invoices + budget |
| 11 | `page-finances` | `views/app.html:3435` | |
| 12 | `page-my-business` | `views/app.html:3590` | PS settings/config |
| 13 | `page-menu` | `views/app.html:3835` | |
| 14 | `page-inventory-ps` | `views/app.html:3870` | Inventory + vendors |

Plus the app shell (nav/topbar, `views/app.html:2182`–`2231`), the persistent command center (`views/app.html:14242`–`14251`), and 24 modals (`views/app.html:3926`–`4185` for PS, `views/app.html:13518`–`14226` for the legacy set).

A shared helper `api()` is declared at `views/app.html:4467` and issues its single `fetch('/api/' + path, options)` at `views/app.html:4470`. Rows citing an `api(...)` call resolve their network request there.

### 1.0 App shell (nav / topbar)

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| Nav: Home / My Business / Operations / Calendar / Reports / Admin / Finances / Services & Products / Inventory (PS) / Maintenance / Contacts / Inventory (PM) / Tasks | Switch active page; each page's loaders fire on land | client-only nav | `views/app.html:2195`–`2212` (13 items) | `showPage()` `views/app.html:4208` | — |
| Nav: Inbox | Switch to inbox and load messages | `GET /api/messages?folder=…` | `views/app.html:2197` | `loadInbox` `views/app.html:4478` | `views/app.html:4498` |
| Sidebar overlay dismiss | Closes mobile drawer | client-only | `views/app.html:2182` | `closeMobileSidebar()` `views/app.html:8883` | — |
| Hamburger ☰ | Toggles mobile sidebar | client-only | `views/app.html:2220` | `toggleMobileSidebar()` `views/app.html:8871` | — |
| Sign Out | Logs the owner out | `GET /api/logout` | `views/app.html:2225` | anchor href | `views/app.html:2225` |
| Manage Billing (banner CTA) | Opens Stripe billing portal | `POST /api/billing/portal-session` | `views/app.html:2230` | `openBillingPortal()` `views/app.html:8609` | `views/app.html:8611` |
| Command center: Send | Sends prompt to the AI command bar | `POST /api/command` | `views/app.html:14251` | `sendCCMessage` `views/app.html:13365` | `views/app.html:13395` |
| Command center: Enter key | Same as Send | `POST /api/command` | `views/app.html:14243` | `sendCCMessage` `views/app.html:13365` | `views/app.html:13395` |
| Command center: history toggle ▲ | Expands panel, lazily loads chat history | `GET /api/command-history?limit=50` | `views/app.html:14242` | `expandCCPanel` `views/app.html:13258` → `loadCCHistory` `views/app.html:13348` | `views/app.html:13351` |

### 1.1 `page-home-pm`

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| Change Photo | Sets hero banner image | client-only (localStorage) | `views/app.html:2252` | `uploadBannerPhoto()` `views/app.html:9724` | — (`:9732` localStorage) |
| Edit Name | Renames the property header | client-only (localStorage) | `views/app.html:2254` | `editPropertyName()` `views/app.html:9737` | — (`:9743`) |
| Stat tiles ×4 (Messages / Tasks / Contacts / Events) | Navigate to the matching page | client-only nav | `views/app.html:2263`, `2268`, `2273`, `2278` | `showPage()` `views/app.html:4208` | — |
| AI command input (Enter) | Submits an AI command | `POST /api/command` | `views/app.html:2300` | `submitHomeCommand()` `views/app.html:9504` | `views/app.html:9580` |
| Mic (dictation) | Web Speech dictation, auto-submits | client-only → `POST /api/command` | `views/app.html:2301` | `toggleDictation()` `views/app.html:8898` | `views/app.html:9580` |
| Send ▶ | Submits an AI command | `POST /api/command` | `views/app.html:2306` | `submitHomeCommand()` `views/app.html:9504` | `views/app.html:9580` |
| Generate Snapshot | Generates an AI property report | `POST /api/report` | `views/app.html:2343` | `generateReport()` `views/app.html:9643` | `views/app.html:9668` |
| Close Report | Hides the report panel | client-only | `views/app.html:9713` (template) | inline | — |
| Lease card "View All" | Navigate to Contacts | client-only nav | `views/app.html:2363` | `showPage()` `views/app.html:4208` | — |
| Quick tiles ×6 (Inbox / Operations / Calendar / Admin / Contacts / Tasks) | Navigate | client-only nav | `views/app.html:2370`, `2375`, `2380`, `2385`, `2390`, `2395` | `showPage()` `views/app.html:4208` | — |
| Approve (approval-queue row) | Executes a queued AI tool call | `POST /api/pending-actions/:id/approve` | `views/app.html:9145` (template) | `approvePendingAction()` `views/app.html:9173` | `views/app.html:9178` |
| Reject (approval-queue row) | Discards a queued AI action | `POST /api/pending-actions/:id/reject` | `views/app.html:9146` (template) | `rejectPendingAction()` `views/app.html:9200` | `views/app.html:9206` |
| Approve (inline chip) | Same approve, chip-local | `POST /api/pending-actions/:id/approve` | `views/app.html:9090` (template) | `approvePendingActionFromChip()` `views/app.html:9226` | `views/app.html:9233` |
| Reject (inline chip) | Same reject, chip-local | `POST /api/pending-actions/:id/reject` | `views/app.html:9091` (template) | `rejectPendingActionFromChip()` `views/app.html:9262` | `views/app.html:9270` |
| Lease-expiration row click | Jumps to Contacts, selects resident | client-only nav | `views/app.html:8012` (template) | `loadLeases()` `views/app.html:8001` | `views/app.html:8002` (load only) |

### 1.2 `page-home-ps`

Page data: `loadPSDashboard()` `views/app.html:8284` → `GET /api/dashboard/ps` at `views/app.html:8286`.

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| "See calendar →" | Navigate to Calendar | client-only nav | `views/app.html:2434` | `showPage()` `views/app.html:4208` | — |
| "See all →" (transactions) | Navigate to Finances | client-only nav | `views/app.html:2462` | `showPage()` `views/app.html:4208` | — |
| "See all →" (low stock) | Navigate to PS Inventory | client-only nav | `views/app.html:2472` | `showPage()` `views/app.html:4208` | — |
| Appointment row click | Navigate to Calendar | client-only nav | `views/app.html:8387` (template) | `renderPSAppointmentsList()` `views/app.html:8379` | — |
| Approve (PS approvals row) | Executes queued AI action | `POST /api/pending-actions/:id/approve` | `views/app.html:8436` (template) | `approvePendingAction()` `views/app.html:9173` | `views/app.html:9178` |
| Reject (PS approvals row) | Rejects queued AI action | `POST /api/pending-actions/:id/reject` | `views/app.html:8437` (template) | `rejectPendingAction()` `views/app.html:9200` | `views/app.html:9206` |
| Transaction row click | Navigate to Finances | client-only nav | `views/app.html:8454` (template) | `renderPSTransactionsList()` `views/app.html:8443` | — |
| Low-stock row click | Navigate to PS Inventory | client-only nav | `views/app.html:8475` (template) | `renderPSLowStockList()` `views/app.html:8465` | — |

AI-conversation rows (`renderPSConversationsList` `views/app.html:8397`) are deliberately non-interactive — no handler.

### 1.3 `page-inbox`

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| Folder: Inbox / Archive / Deleted | Loads that folder | `GET /api/messages?folder=…` | `views/app.html:2496`, `2497`, `2498` | `switchFolder()` `views/app.html:4482` | `views/app.html:4498` |
| Empty Trash | Permanently deletes all trashed messages | `DELETE /api/messages/folder/deleted` | `views/app.html:2500` | `emptyTrash()` `views/app.html:4562` | `views/app.html:4564` |
| Message row click | Opens detail + AI drafts | `GET /api/messages/:id`, `GET /api/drafts` | `views/app.html:4523` | `showMessage()` `views/app.html:4590` | `views/app.html:4591`, `4638` |
| 🗄 Archive (row) | Moves message to archive | `PUT /api/messages/:id/folder` | `views/app.html:4528` | `moveMessage()` `views/app.html:4539` | `views/app.html:4540` |
| ↩ Restore (row, deleted folder) | Moves message back to inbox | `PUT /api/messages/:id/folder` | `views/app.html:4529` | `moveMessage()` `views/app.html:4539` | `views/app.html:4540` |
| ✖ Delete Forever (row) | Hard-deletes the message | `DELETE /api/messages/:id` | `views/app.html:4530` | `permanentDelete()` `views/app.html:4552` | `views/app.html:4554` |
| 🗑 Delete (row) | Soft-deletes to Deleted folder | `PUT /api/messages/:id/folder` | `views/app.html:4530` | `moveMessage()` `views/app.html:4539` | `views/app.html:4540` |
| Mark Reviewed (emergency banner) | Clears the emergency flag | `POST /api/messages/:id/clear-emergency` | `views/app.html:4612` | `markEmergencyReviewed()` `views/app.html:4660` | `views/app.html:4661` |
| ✨ Generate AI Draft | Generates an AI reply draft | `POST /api/generate` | `views/app.html:4630` | `generateDraft()` `views/app.html:4757` | `views/app.html:4761` |
| 📱 Reply via SMS | Prompts and sends SMS reply | `POST /api/sms/send` | `views/app.html:4631` | `sendSMSReply()` `views/app.html:4719` | `views/app.html:4723` |
| ✉ Reply via Email | Prompts and sends email reply | `POST /api/email/send` | `views/app.html:4632` | `sendEmailReply()` `views/app.html:4737` | `views/app.html:4743` |
| 🗄 Archive / ↩ Move to Inbox (detail) | Moves the open message | `PUT /api/messages/:id/folder` | `views/app.html:4633` | `moveMessage()` `views/app.html:4539` | `views/app.html:4540` |
| 🗑 Delete / ✖ Delete Forever (detail) | Soft- or hard-deletes the open message | `PUT /api/messages/:id/folder` / `DELETE /api/messages/:id` | `views/app.html:4634` | `moveMessage()` `:4539` / `permanentDelete()` `:4552` | `views/app.html:4540` / `4554` |
| Draft textarea edit | Edits draft body before sending | client-only | `views/app.html:4644` | — | — |
| ✉ Send Reply (per draft) | Sends the edited draft | `POST /api/email/send` **or** `POST /api/sms/send` | `views/app.html:4646` | `sendDraft()` `views/app.html:4683` | `views/app.html:4691` / `4700` |
| 📋 Copy (per draft) | Copies draft to clipboard | client-only | `views/app.html:4647` | `copyDraft()` `views/app.html:4713` | — |

### 1.4 `page-operations`

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| Radio: Auto-reply | Selects auto-reply mode | client-only until Save | `views/app.html:2561` | `updateModeUI()` `views/app.html:4793` | — |
| Radio: Manager review | Selects review mode | client-only until Save | `views/app.html:2568` | `updateModeUI()` `views/app.html:4793` | — |
| Save settings | Saves automation mode; enable path routes through the consent modal | `POST /api/automation/consent` (enable) / `PUT /api/automation` (disable) | `views/app.html:2575` | `saveAutomation()` `views/app.html:4985`; `submitAutoReplyConsent()` `views/app.html:5055` | `views/app.html:5011` / `5059` |
| "I already have a business email" | Shows existing-email form | client-only | `views/app.html:2598` | `chooseEmailPath()` `views/app.html:9821` | — |
| "Create a new dedicated Gmail" | Shows new-Gmail walkthrough | client-only | `views/app.html:2602` | `chooseEmailPath()` `views/app.html:9821` | — |
| ← Back ×2 | Returns to path picker | client-only | `views/app.html:2614`, `2633` | `backToPathPicker()` `views/app.html:9827` | — |
| "I'm ready → Enter credentials" | Jumps to credentials form | client-only | `views/app.html:2628` | `showConnectForm()` `views/app.html:9833` | — |
| Email address field (`oninput`) | Auto-detects IMAP/SMTP for the domain | `GET /api/email-account/detect?email=…` | `views/app.html:2644` | `previewDetection()` `views/app.html:9837` | `views/app.html:9841` → `4470` |
| App password field | Credential input | client-only | `views/app.html:2647` | `buildConnectPayload()` `views/app.html:9865` | — |
| Advanced IMAP/SMTP host+port ×4 | Override auto-detected servers | client-only | `views/app.html:2651`–`2654` | `buildConnectPayload()` `views/app.html:9865` | — |
| Test | Tests credentials without saving | `POST /api/email-account/test` | `views/app.html:2658` | `testEmailConnection()` `views/app.html:9847` | `views/app.html:9852` |
| Connect & Save | Saves the mailbox, starts syncing | `POST /api/email-account/connect` | `views/app.html:2659` | `connectEmailAccount()` `views/app.html:9876` | `views/app.html:9886` |
| ↻ Sync now | Pulls new mail immediately | `POST /api/email-account/sync` | `views/app.html:9808` (template) | `syncEmailNow()` `views/app.html:9900` | `views/app.html:9903` |
| Disconnect | Removes the connected mailbox | `DELETE /api/email-account` | `views/app.html:9809` (template) | `disconnectEmail()` `views/app.html:9910` | `views/app.html:9912` |
| 🗑 Remove knowledge doc (per row) | Deletes a KB document | `DELETE /api/knowledge/:id` | `views/app.html:5097` (template) | `deleteKnowledge()` `views/app.html:5102` | `views/app.html:5104` |
| Upload zone click | Opens file picker | client-only | `views/app.html:2682` | inline | — |
| File input (`onchange`) | Uploads PDF/TXT to knowledge base | `POST /api/knowledge/upload` | `views/app.html:2684` | `uploadFile()` `views/app.html:5108` | `views/app.html:5117` |
| KB form submit / "Add Document" | Adds a manual KB entry | `POST /api/knowledge` | `views/app.html:2690`, `2698` | `addKnowledge()` `views/app.html:5139` | `views/app.html:5154` |
| Select: KB document type | Sets `type` on the KB payload | client-only (part of POST body) | `views/app.html:2692` | read at `views/app.html:5141` | `views/app.html:5154` |

### 1.5 `page-calendar`

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| ← Previous | Steps back one period | client-only | `views/app.html:2723` | `changeCalNav` `views/app.html:5238` | — |
| Month select | Jumps to that month | client-only | `views/app.html:2724` | `onCalMonthChange` `views/app.html:5254` | — |
| Year select | Jumps to that year | client-only | `views/app.html:2725` | `onCalYearChange` `views/app.html:5265` | — |
| → Next | Steps forward one period | client-only | `views/app.html:2726` | `changeCalNav` `views/app.html:5238` | — |
| Today | Snaps to today in workspace tz | client-only | `views/app.html:2727` | `jumpToToday` `views/app.html:5273` | — |
| View tabs: Day / Week / Month / Year | Switches calendar view | client-only | `views/app.html:2729`–`2732` | `setCalView` `views/app.html:5287` | — |
| Block time | Opens block-off modal | `POST /api/calevents` | `views/app.html:2734` | `openBlockOffTime` `views/app.html:5957` → `submitBlockOff` `views/app.html:5995` | `views/app.html:6035` |
| + Add Event | Opens event modal | `POST /api/calevents` (+ optional `POST /api/tasks`) | `views/app.html:2735` | `openAddEvent` `views/app.html:6538` → `submitAddEvent` `views/app.html:6562` | `views/app.html:6581`, `6585` → `4470` |
| Sheet backdrop click | Closes mobile bottom sheet | client-only | `views/app.html:2743` | `closeCalSheet` `views/app.html:5809` | — |
| Day cell click (month grid) | Selects the day, opens day panel | client-only | `views/app.html:5458` (template) | `selectDay` `views/app.html:5792` | — |
| Event chip click (month cell) | Opens event detail modal | `GET /api/calevents/:id` | `views/app.html:5440` (template) | `openCalEventDetail` `views/app.html:6208` | `views/app.html:6223` |
| Task line click (month cell) | Opens task detail modal | client-only | `views/app.html:5443` (template) | `openTaskDetail` `views/app.html:6121` | — |
| `+N more` | Reveals all items for that day | client-only | `views/app.html:5446` (template) | `selectDay` `views/app.html:5792` | — |
| Empty-state `+ New event` | Opens add-event modal | `POST /api/calevents` | `views/app.html:5369` (template) | `submitAddEvent` `views/app.html:6562` | `views/app.html:6581` |
| Mini-month day / header click (year view) | Opens that month | client-only | `views/app.html:5507`, `5510` (templates) | `openMonthFromYear` `views/app.html:5784` | — |
| Week day-header click | Focus that day, switch to Day view | client-only | `views/app.html:5683` (template) | `setCalView` `views/app.html:5287` | — |
| All-day chip click (timeline) | Opens event detail modal | `GET /api/calevents/:id` | `views/app.html:5700` (template) | `openCalEventDetail` `views/app.html:6208` | `views/app.html:6223` |
| All-day task line click | Opens task detail modal | client-only | `views/app.html:5703` (template) | `openTaskDetail` `views/app.html:6121` | — |
| Hour-cell click (timeline) | Opens New-event/Block-off popover | client-only | `views/app.html:5721` (template) | `calTimelineSlotClick` `views/app.html:5569` | — |
| Popover → New event | Add-event modal prefilled to that half-hour | `POST /api/calevents` | `views/app.html:5578` (template) | `_slotPopChoose` `views/app.html:5600` → `openAddEventOnDate` `views/app.html:5921` | `views/app.html:6581` |
| Popover → Block off | Block-off modal prefilled 1 hour | `POST /api/calevents` | `views/app.html:5579` (template) | `_slotPopChoose` `views/app.html:5600` → `openBlockOffTime` `views/app.html:5957` | `views/app.html:6035` |
| Timed event block click | Opens event detail modal | `GET /api/calevents/:id` | `views/app.html:5732` (template) | `openCalEventDetail` `views/app.html:6208` | `views/app.html:6223` |
| Day panel: event row click | Opens event detail modal | `GET /api/calevents/:id` | `views/app.html:5867` (template) | `openCalEventDetail` `views/app.html:6208` | `views/app.html:6223` |
| Day panel: event row ✕ delete | Deletes the calendar event | `DELETE /api/calevents/:id` | `views/app.html:5871` (template) | `deleteCalEvent` `views/app.html:6058` | `views/app.html:6060` |
| Day panel: task checkbox | Toggles task done | `PUT /api/tasks/:id` | `views/app.html:5893` (template) | `calToggleTask` `views/app.html:6097` | `views/app.html:6104` |
| Day panel: task title click | Opens task detail modal | client-only | `views/app.html:5894` (template) | `openTaskDetail` `views/app.html:6121` | — |
| Day panel: task row ✕ delete | Deletes the task | `DELETE /api/tasks/:id` | `views/app.html:5896` (template) | `calDeleteTask` `views/app.html:6073` | `views/app.html:6075` |
| Sheet handle click/drag | Dismisses mobile sheet | client-only | `views/app.html:5903` (template) | `closeCalSheet` `views/app.html:5809` | — |
| Day panel: + Add Event | Event modal prefilled with that date | `POST /api/calevents` | `views/app.html:5912` (template) | `openAddEventOnDate` `views/app.html:5921` | `views/app.html:6581` |
| Day panel: 🚫 Block off time | Block-off modal for that date | `POST /api/calevents` | `views/app.html:5913` (template) | `openBlockOffTime` `views/app.html:5957` | `views/app.html:6035` |
| Day panel: + Add Task | Navigates to Tasks with due date prefilled | client-only nav | `views/app.html:5914` (template) | `openAddTaskOnDate` `views/app.html:5942` | — |
| Event modal: Add follow-up task | Swaps to mini task form | client-only | `views/app.html:6312` (template) | `calEventFollowUpForm` `views/app.html:6326` | — |
| Event modal: Create task | Creates a task linked to the event | `POST /api/tasks` | `views/app.html:6344` (template) | `calEventFollowUpCreate` `views/app.html:6346` | `views/app.html:6359` |
| Event modal: Edit (appointment) | Swaps to appointment edit form | client-only | `views/app.html:6315` (template) | `calEventDetailEdit` `views/app.html:6413` | — |
| Event modal: Save changes | Saves title/date/time/duration/price | `PATCH /api/appointments/:id` | `views/app.html:6453` (template) | `calEventDetailSave` `views/app.html:6456` | `views/app.html:6492` |
| Event modal: Cancel appointment | Inline confirm, then cancels | `DELETE /api/calevents/:id` | `views/app.html:6316`, confirm `6383` | `calEventDetailConfirmCancel` `views/app.html:6377` → `calEventDetailDelete` `views/app.html:6515` | `views/app.html:6519` |
| Event modal: Delete / Remove (plain / time_off) | Inline confirm, then removes | `DELETE /api/calevents/:id` | `views/app.html:6318`, confirm `6383` | `calEventDetailDelete` `views/app.html:6515` | `views/app.html:6519` |
| Event modal: Keep / Back / Close | Aborts or closes | client-only | `views/app.html:6382`, `6452`, `6320` | `renderCalEventDetail` `views/app.html:6254`, `closeCalEventDetail` `views/app.html:6234` | — |

There are **no approve/decline controls for `requested` appointments anywhere on the calendar** — the lifecycle exposed here is Edit / Cancel only. Verified across `renderCalEventDetail` `views/app.html:6254`–`6325`.

### 1.6 `page-reports`

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| Type filter select | Re-fetches list filtered by type | `GET /api/reports?type=…` | `views/app.html:2784` | `loadReportsList` `views/app.html:7841` | `views/app.html:7849` |
| + New Report | Opens new-report modal | `POST /api/reports` | `views/app.html:2792` | `openNewReportModal` `views/app.html:7940` → `submitNewReport` `views/app.html:7953` | `views/app.html:7972` |
| Report type select (modal) | Sets report type on the payload | client-only | `views/app.html:13906` | read in `submitNewReport` `views/app.html:7953` | `views/app.html:7972` |
| Report row click | Opens detail modal | `GET /api/reports/:id` | `views/app.html:7872` (template) | `viewReport` `views/app.html:7895` | `views/app.html:7897` |
| Delete (detail modal) | Deletes the open report | `DELETE /api/reports/:id` | `views/app.html:13946` | `deleteCurrentReport` `views/app.html:7923` | `views/app.html:7927` |

### 1.7 `page-contacts`

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| Search input | Filters the cached contact grid | client-only | `views/app.html:2823` | `renderContacts` `views/app.html:7416` | — |
| Filter: All / Residents / Vendors / Important | Filters by contact type | client-only | `views/app.html:2825`, `2828`, `2829`, `2830` | `filterContactType` `views/app.html:7409` | — |
| Import CSV (file input) | Uploads CSV, reloads contacts | `POST /api/contacts/import` | `views/app.html:2834` | `importContactsCSV` `views/app.html:8834` | `views/app.html:8846` |
| Broadcast | Opens the group email/SMS modal | `POST /api/broadcast` | `views/app.html:2836` | `openBroadcast` `views/app.html:8679` → `sendBroadcast` `views/app.html:8745` | `views/app.html:8770` → `4470` |
| + Add Contact | Opens empty contact modal | `POST /api/contacts` | `views/app.html:2837` | `openAddContact` `views/app.html:7634` → `submitContactModal` `views/app.html:7693` | `views/app.html:7735` |
| Contact card click | Selects contact, renders detail pane | client-only | `views/app.html:7441` (template) | `selectContact` `views/app.html:7455` | — |
| ✉ Compose Message (detail) | Pushes a message into the local inbox array only | client-only — **no fetch** | `views/app.html:7499` (template) | `composeToContact` `views/app.html:7506` | — |
| ✎ Edit Contact (detail) | Opens contact modal prefilled | `PUT /api/contacts/:id` (+ engagement writes) | `views/app.html:7500` (template) | `openEditContact` `views/app.html:7655` → `submitContactModal` `views/app.html:7693` | `views/app.html:7724`, `7763`, `7793` |
| Remove Contact (detail) | Deletes the contact | `DELETE /api/contacts/:id` | `views/app.html:7501` (template) | `deleteContact` `views/app.html:8023` | `views/app.html:8025` |
| Contact type select (modal) | Reveals/hides lease-details block | client-only | `views/app.html:13687` | `toggleLeaseFields` `views/app.html:7529` | — |
| Broadcast modal: Email / SMS channel | Switches channel, re-filters recipients | client-only | `views/app.html:14188`, `14192` | `setBroadcastChannel` `views/app.html:8699` | — |
| Broadcast modal: Recipients select | Re-filters audience (all/resident/vendor/important) | client-only | `views/app.html:14200` | `updateBroadcastPreview` `views/app.html:8726` | — |
| Broadcast modal: Send to N contacts | Queues the broadcast | `POST /api/broadcast` | `views/app.html:14226` | `sendBroadcast` `views/app.html:8745` | `views/app.html:8770` → `4470` |

### 1.8 `page-inventory` (PM properties & units)

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| + Add Property | Opens create-property modal | `POST /api/entities` | `views/app.html:2893` | `openAddProperty` `views/app.html:10130` → `submitPropertyModal` `views/app.html:10146` | `views/app.html:10174` |
| ✎ Edit (property) | Swaps pane into edit form | `GET /api/entities/:id` | `views/app.html:2897` | `editCurrentProperty` `views/app.html:11343` | `views/app.html:11346` |
| 🗑 Archive (property) | Soft-deletes the property | `DELETE /api/entities/:id` | `views/app.html:2898` | `archiveCurrentProperty` `views/app.html:11420` | `views/app.html:11428` |
| Cancel (property edit) | Discards edits | client-only | `views/app.html:2902` | `cancelPropertyEdit` `views/app.html:11370` | — |
| Save Changes (property edit) | Patches the property | `PATCH /api/entities/:id` | `views/app.html:2903` | `savePropertyEdit` `views/app.html:11380` | `views/app.html:11388` |
| ✎ Edit (unit) | Swaps to unit edit form | `GET /api/offerings/:id` | `views/app.html:2907` | `editCurrentUnit` `views/app.html:11015` | `views/app.html:11018` |
| 🗑 Retire (unit) | Soft-deletes the unit | `DELETE /api/offerings/:id` | `views/app.html:2908` | `retireCurrentUnit` `views/app.html:11111` | `views/app.html:11120` |
| Cancel (unit edit) | Discards edits | client-only | `views/app.html:2912` | `cancelUnitEdit` `views/app.html:11041` | — |
| Save Changes (unit edit) | Patches unit, reconciles tenant engagement | `PATCH /api/offerings/:id` + engagement writes | `views/app.html:2913` | `saveUnitEdit` `views/app.html:11052` | `views/app.html:11071`, `11097` |
| + Add Your First Property (empty state) | Same as Add Property | `POST /api/entities` | `views/app.html:2926` | `submitPropertyModal` `views/app.html:10146` | `views/app.html:10174` |
| Property card click | Opens property detail pane | client-only | `views/app.html:10111` (template) | `openPropertyDetail` `views/app.html:10201` | — |
| Breadcrumb links (Properties / property) | Navigate back up | client-only | `views/app.html:10224`, `10803`, `11410` | `showPropertyList` `views/app.html:10233`, `openPropertyDetail` `views/app.html:10201` | — |
| + Add Unit / + Add First Unit | Opens create-unit modal | `POST /api/offerings` | `views/app.html:10424`, `10435` (templates) | `openAddUnit` `views/app.html:10649` → `submitUnitModal` `views/app.html:10684` | `views/app.html:10731` |
| Unit table row click | Opens unit detail + engagement history | `GET /api/engagements?offering_id=…` | `views/app.html:10452` (template) | `openUnitDetail` `views/app.html:10774` | `views/app.html:10817` → `4470` |
| Unit modal: Tenant select | Drives engagement creation on save | `PATCH /api/engagements/:id` + `POST /api/engagements` | `views/app.html:13877` | `_invReconcileTenantOnOffering` `views/app.html:10547` | `views/app.html:10569`, `10598`, `10623` |
| Unit modal: Frequency select | Sets `price_frequency` | client-only (part of payload) | `views/app.html:13853` | `submitUnitModal` `views/app.html:10684` | `views/app.html:10731` |

### 1.9 `page-tasks`

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| Filter: All / Pending / Done / Overdue | Filters the task list | client-only | `views/app.html:2987`–`2990` | `filterTasks` `views/app.html:7127` | — |
| New-task form submit / "Add Task" | Creates a task | `POST /api/tasks` | `views/app.html:3010`, `3029` | `addTask` `views/app.html:7102` | `views/app.html:7108` → `4470` |
| "AI Suggested" chip | Scrolls to suggestions | client-only | `views/app.html:7156` (template) | inline | — |
| ✓ Approve (suggested task) | Promotes an AI suggestion to a real task | `PUT /api/tasks/:id/approve` | `views/app.html:7179` (template) | `approveTask` `views/app.html:7134` | `views/app.html:7135` |
| ✕ Reject (suggested task) | Dismisses the AI suggestion | `DELETE /api/tasks/:id/reject` | `views/app.html:7180` (template) | `rejectTask` `views/app.html:7138` | `views/app.html:7139` |
| Task checkbox (row) | Toggles done state | `PUT /api/tasks/:id` | `views/app.html:7204` (template) | `toggleTask` `views/app.html:7115` | `views/app.html:7118` |
| ✕ delete (task row) | Deletes the task | `DELETE /api/tasks/:id` | `views/app.html:7213` (template) | `deleteTask` `views/app.html:7122` | `views/app.html:7123` |
| Task detail modal: Complete | Marks the open task done | `PUT /api/tasks/:id` | `views/app.html:6142` (template) | `taskDetailComplete` `views/app.html:6149` | `views/app.html:6156` |

### 1.10 `page-maintenance`

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| Status filter select | Filters cached tickets | client-only | `views/app.html:3076` | `renderMaintenance` `views/app.html:7247` | — |
| + New Ticket | Opens blank maintenance modal | `POST /api/maintenance` | `views/app.html:3084` | `openNewTicket` `views/app.html:7343` → `submitMaintTicket` `views/app.html:7373` | `views/app.html:7389` → `4470` |
| Summary chips: Open / In Progress / Resolved / Emergency | Sets the filter | client-only | `views/app.html:7262`, `7265`, `7268`, `7271` (templates) | `renderMaintenance` `views/app.html:7247` | — |
| Per-ticket status select | Quick status change | `PUT /api/maintenance/:id` | `views/app.html:7316` (template) | `quickUpdateStatus` `views/app.html:7330` | `views/app.html:7333` → `4470` |
| ✎ Update / Resolve | Opens modal with outcome/action-notes | `PUT /api/maintenance/:id` | `views/app.html:7321` (template) | `openUpdateTicket` `views/app.html:7351` → `submitMaintTicket` `views/app.html:7373` | `views/app.html:7387` |
| ✎ Edit (resolved) | Same modal for a resolved ticket | `PUT /api/maintenance/:id` | `views/app.html:7322` (template) | `openUpdateTicket` `views/app.html:7351` | `views/app.html:7387` |
| 🗑 Delete (per ticket) | Deletes the ticket | `DELETE /api/maintenance/:id` | `views/app.html:7323` (template) | `deleteMaintTicket` `views/app.html:7337` | `views/app.html:7339` → `4470` |
| Modal: Category select | Sets ticket category | client-only (part of payload) | `views/app.html:13587` | `submitMaintTicket` `views/app.html:7373` | `views/app.html:7387`/`7389` |
| Modal: Status select | Sets status on update | client-only (part of payload) | `views/app.html:13604` | `submitMaintTicket` `views/app.html:7373` | `views/app.html:7387` |
| Modal: "Office action required" checkbox | Flags `requires_action` | client-only (part of payload) | `views/app.html:13614` | `submitMaintTicket` `views/app.html:7373` | `views/app.html:7387` |

### 1.11 `page-admin`

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| Email notifications toggle | Flips inbox email alerts, saves immediately | `PUT /api/settings` | `views/app.html:3127` | `saveNotifSettings` `views/app.html:4836` | `views/app.html:4845` → `4470` |
| Push notifications toggle | Per-device push opt-in; subscribes the service worker | `GET /api/push/vapid-public-key`, `POST /api/push/subscribe` | `views/app.html:3141` | `enablePushOnThisDevice` `views/app.html:4924` | `views/app.html:4934`, `4948` |
| Notification email input | Marks the field dirty so reloads don't clobber typing | client-only | `views/app.html:3152` | inline | — |
| Emergency alert phone input | Free-text field persisted on Save | client-only | `views/app.html:3156` | — | — |
| Save settings | Persists notification email, toggle, alert phone | `PUT /api/settings` | `views/app.html:3159` | `saveNotifSettings` `views/app.html:4836` | `views/app.html:4845` |
| Track inventory toggle | Turns the Inventory page on/off for the workspace | `POST /api/workspace/inventory-tracking` | `views/app.html:3227` | `toggleInventoryTracking` `views/app.html:8486` | `views/app.html:8488` |
| Manage Billing | Opens Stripe billing portal | `POST /api/billing/portal-session` | `views/app.html:3234` | `openBillingPortal` `views/app.html:8609` | `views/app.html:8611` |
| Upgrade Plan | Same handler as Manage Billing | `POST /api/billing/portal-session` | `views/app.html:3235` | `openBillingPortal` `views/app.html:8609` | `views/app.html:8611` |
| Copy (forwarding address) | Copies inbound alias to clipboard | client-only | `views/app.html:3256` | `copyForwardingAddress` `views/app.html:9924` | — |
| ↻ Refresh (payment events) | Reloads recent payment events | `GET /api/payments/events` | `views/app.html:3267` | `loadPaymentEvents` `views/app.html:9934` | `views/app.html:9935` → `4470` |
| Run AI Match | Runs a pasted payment email through the AI matcher | `POST /api/payments/test` | `views/app.html:3277` | `testPaymentEmail` `views/app.html:9986` | `views/app.html:9992` |
| ✓ Confirm match (per event) | Confirms the AI's tenant match, applies it to rent | `POST /api/payments/events/:id/confirm` | `views/app.html:9953` (template) | `confirmPaymentEvent` `views/app.html:9974` | `views/app.html:9975` |
| Dismiss (per event) | Marks the payment event dismissed | `POST /api/payments/events/:id/dismiss` | `views/app.html:9954` (template) | `dismissPaymentEvent` `views/app.html:9981` | `views/app.html:9982` |
| Rent month select | Refilters the rent roll by month | `GET /api/rent?month=&year=` | `views/app.html:3299` | `loadRentTable` `views/app.html:6595` | `views/app.html:6599` |
| Rent year select | Refilters by year | `GET /api/rent?month=&year=` | `views/app.html:3305` | `loadRentTable` `views/app.html:6595` | `views/app.html:6599` |
| ⚡ Generate Month | Opens generate-rent modal | client-only (opens modal) | `views/app.html:3310` | `openGenerateRent` `views/app.html:6702` | — |
| Generate (modal) | Bulk-creates rent rows for all residents | `POST /api/rent/generate-month` | `views/app.html:14115` | `submitGenerateRent` `views/app.html:6713` | `views/app.html:6719` → `4470` |
| + Add Manually | Opens blank add-rent modal | client-only (opens modal) | `views/app.html:3311` | `openAddRent` `views/app.html:6692` | — |
| Save Rent Record (modal) | Creates one rent record | `POST /api/rent` | `views/app.html:14142` | `submitRent` `views/app.html:6736` | `views/app.html:6743` → `4470` |
| ✓ Mark Paid (per rent row) | Sets that rent record to paid | `PUT /api/rent/:id` | `views/app.html:6653` (template) | `markRentPaid` `views/app.html:6662` | `views/app.html:6663` → `4470` |
| 📨 Notice (per rent row) | Sends a late-payment notice | `POST /api/rent/:id/late-notice` | `views/app.html:6654` (template) | `sendLateNotice` `views/app.html:6672` | `views/app.html:6675` → `4470` |
| 🗑 Delete (per rent row) | Deletes the rent record | `DELETE /api/rent/:id` | `views/app.html:6655` (template) | `deleteRent` `views/app.html:6686` | `views/app.html:6688` → `4470` |
| + Add Invoice | Opens add-invoice modal | client-only (opens modal) | `views/app.html:3348` | `openAddInvoice` `views/app.html:6786` | — |
| Save Invoice (modal) | Creates a vendor invoice | `POST /api/invoices` | `views/app.html:14169` | `submitInvoice` `views/app.html:6795` | `views/app.html:6802` → `4470` |
| ✓ Approve / ✕ Reject / Reset (per invoice row) | Sets invoice status approved / rejected / pending | `PUT /api/invoices/:id` | `views/app.html:6766`, `6767`, `6768` (templates) | `updateInvoiceStatus` `views/app.html:6775` | `views/app.html:6776` → `4470` |
| 🗑 Delete (per invoice row) | Deletes the invoice | `DELETE /api/invoices/:id` | `views/app.html:6769` (template) | `deleteInvoice` `views/app.html:6780` | `views/app.html:6782` → `4470` |
| Budget month / year select | Refetches the ledger | `GET /api/budget?month=&year=` | `views/app.html:3385`, `3391` | `loadBudget` `views/app.html:6808` | `views/app.html:6811` → `4470` |
| Transaction type select (All/Income/Expenses) | Client-side filter over loaded rows | client-only | `views/app.html:3394` | `renderBudget` `views/app.html:6815` | — |
| + Add Transaction | Opens budget transaction modal | client-only (opens modal) | `views/app.html:3400` | `openAddTransaction` `views/app.html:6913` | — |
| Add Transaction (modal submit) | Creates a budget income/expense row | `POST /api/budget` | `views/app.html:13669` | `submitAddTransaction` `views/app.html:6934` | `views/app.html:6942` → `4470` |
| Type select (budget modal) | Repopulates the category dropdown | client-only | `views/app.html:13639` | `updateTxCategories` `views/app.html:6925` | — |
| 🗑 Delete (per budget row) | Deletes the transaction | `DELETE /api/budget/:id` | `views/app.html:6875` (template) | `deleteTransaction` `views/app.html:6907` | `views/app.html:6909` → `4470` |

### 1.12 `page-finances`

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| Set up card payments | Starts Stripe Connect onboarding | `POST /api/connect/onboarding/start` | `views/app.html:3462` | `startConnectOnboarding` `views/app.html:11784` | `views/app.html:11791` |
| Search transactions | Live full-text filter | `GET /api/transactions?q=` | `views/app.html:3478` | `loadTransactions` `views/app.html:11885` | `views/app.html:11903` |
| Refresh | Re-runs the transactions query | `GET /api/transactions?…` | `views/app.html:3481` | `loadTransactions` `views/app.html:11885` | `views/app.html:11903` |
| Export CSV | Downloads filtered transactions as CSV | `GET /api/transactions/export.csv?…` | `views/app.html:3482` | `exportTransactionsCsv` `views/app.html:11935` | `views/app.html:11949` |
| New transaction | Opens the blank new-transaction modal | client-only (opens modal) | `views/app.html:3483` | `openNewTransactionModal` `views/app.html:12186` | — |
| Create transaction (modal) | Builds a `create_transaction` prompt and posts it to the AI bus | `POST /api/command` | `views/app.html:4182` | `submitNewTransaction` `views/app.html:12198` | `views/app.html:12209` |
| Payment method select (new-tx modal) | Sets `payment_method` on the prompt | client-only (part of payload) | `views/app.html:4164` | `submitNewTransaction` `views/app.html:12198` | `views/app.html:12209` |
| Customer filter | Filters by customer name | `GET /api/transactions?customer_name=` | `views/app.html:3491` | `loadTransactions` `views/app.html:11885` | `views/app.html:11903` |
| From / To date filters | Filters by date range | `GET /api/transactions?start_date=&end_date=` | `views/app.html:3495`, `3499` | `loadTransactions` `views/app.html:11885` | `views/app.html:11903` |
| Payment method filter | Filters by payment method | `GET /api/transactions?payment_method=` | `views/app.html:3503` | `loadTransactions` `views/app.html:11885` | `views/app.html:11903` |
| Status filter | Filters by transaction status | `GET /api/transactions?status=` | `views/app.html:3516` | `loadTransactions` `views/app.html:11885` | `views/app.html:11903` |
| Transaction row click | Opens the transaction detail modal | `GET /api/transactions/:id` | `views/app.html:11919` (template) | `openTxDetail` `views/app.html:11954` | `views/app.html:11956` |
| Send/Resend receipt | Emails or SMSes the receipt | `POST /api/transactions/:id/send-receipt` | `views/app.html:12050` (template) | `resendReceipt` `views/app.html:12105` | `views/app.html:12107` |
| Issue refund | Opens the refund modal | client-only (opens modal) | `views/app.html:12052` (template) | `openRefundModal` `views/app.html:12143` | — |
| Confirm refund (modal) | Posts the refund | `POST /api/transactions/:id/refund` | `views/app.html:4140` | `submitRefund` `views/app.html:12158` | `views/app.html:12166` |
| Request deposit | Creates a Stripe deposit payment link and texts it | `POST /api/transactions/:id/request-payment` | `views/app.html:12055` (template) | `requestPaymentLink` `views/app.html:12070` | `views/app.html:12078` |
| Request payment | Same with `payment_type:'payment'` | `POST /api/transactions/:id/request-payment` | `views/app.html:12058` (template) | `requestPaymentLink` `views/app.html:12070` | `views/app.html:12078` |
| Void | Voids via a natural-language AI command | `POST /api/command` | `views/app.html:12061` (template) | `voidFromDetail` `views/app.html:12117` | `views/app.html:12125` |
| "Manage invoices / budget / rent ledger in Admin →" ×3 | Navigate to Admin | client-only | `views/app.html:3545`, `3558`, `3571` | `showPage` `views/app.html:4208` | — |

### 1.13 `page-my-business` (PS settings)

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| Business Description textarea | Business description fed to the AI | `POST /api/knowledge` / `PUT /api/knowledge/:id` | `views/app.html:3609` | `saveMyBusiness` `views/app.html:12281` | `views/app.html:12301` |
| Hours of Operation textarea | The only business-hours control — free text, unstructured | `POST/PUT /api/knowledge[/:id]` | `views/app.html:3617` | `saveMyBusiness` `views/app.html:12281` | `views/app.html:12301` |
| Policies textarea | Cancellation/late policy text | `POST/PUT /api/knowledge[/:id]` | `views/app.html:3624` | `saveMyBusiness` `views/app.html:12281` | `views/app.html:12301` |
| Save (knowledge block) | Persists the three fields above | `POST/PUT /api/knowledge[/:id]` ×3 | `views/app.html:3630` | `saveMyBusiness` `views/app.html:12281` | `views/app.html:12301` |
| + Add Service | Appends a blank service row | client-only | `views/app.html:3666` | `mbAddServiceRow` `views/app.html:12420` | — |
| × Remove (service row) | Deletes the menu item | `DELETE /api/menu-items/:id` | `views/app.html:12359` (template) | `mbRemoveServiceRow` `views/app.html:12440` → `_mbRemoveRow` `views/app.html:12446` | `views/app.html:12458` |
| Save Services | PATCH existing / POST new service rows | `PATCH /api/menu-items/:id`, `POST /api/menu-items` | `views/app.html:3668` | `mbSaveServices` `views/app.html:12474` | `views/app.html:12501`, `12513` |
| + Add Product | Appends a blank product row | client-only | `views/app.html:3701` | `mbAddProductRow` `views/app.html:12430` | — |
| × Remove (product row) | Deletes the menu item | `DELETE /api/menu-items/:id` | `views/app.html:12369` (template) | `mbRemoveProductRow` `views/app.html:12443` → `_mbRemoveRow` `views/app.html:12446` | `views/app.html:12458` |
| Save Products | PATCH existing / POST new product rows | `PATCH /api/menu-items/:id`, `POST /api/menu-items` | `views/app.html:3703` | `mbSaveProducts` `views/app.html:12535` | `views/app.html:12555`, `12567` |
| ☑ "Let my assistant reply to customers on its own" | Sets `workspaces.appointment_auto_respond` | `PATCH /api/workspace/ai-settings` | `views/app.html:3725` | `mbSaveAISettings` `views/app.html:12618` | `views/app.html:12629` |
| ☑ "Let my assistant book appointments automatically" | Sets `workspaces.appointment_auto_confirm` | `PATCH /api/workspace/ai-settings` | `views/app.html:3735` | `mbSaveAISettings` `views/app.html:12618` | `views/app.html:12629` |
| Tone select (warm / professional / brief) | Sets `workspaces.ai_tone` | `PATCH /api/workspace/ai-settings` | `views/app.html:3754` | `mbSaveAISettings` `views/app.html:12618` (read `:12636`) | `views/app.html:12629` |
| Sales approach select (reactive / proactive) | Sets `workspaces.ai_sales_posture` | `PATCH /api/workspace/ai-settings` | `views/app.html:3766` | `mbSaveAISettings` `views/app.html:12618` (read `:12637`) | `views/app.html:12629` |
| Save settings (AI block) | Sends all four AI fields in one PATCH | `PATCH /api/workspace/ai-settings` | `views/app.html:3777` | `mbSaveAISettings` `views/app.html:12618` | `views/app.html:12629` |
| Website / Google Review Link / Yelp Review Link | Stored as knowledge rows | `POST/PUT /api/knowledge[/:id]` | `views/app.html:3806`, `3811`, `3816` | `mbSaveGrowth` `views/app.html:12697` | `views/app.html:12710` |
| Save links | Persists the three link rows | `POST/PUT /api/knowledge[/:id]` ×3 | `views/app.html:3826` | `mbSaveGrowth` `views/app.html:12697` | `views/app.html:12710` |

There is **no timezone control anywhere** in `views/app.html:3590`–`3833`, and **no structured business-hours editor** — hours exist only as the free-text `mbHours` knowledge row at `views/app.html:3617`.

### 1.14 `page-menu`

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| Tab: Services / Products / Add-ons | Switches `_menuTab`, reloads list | `GET /api/menu-items?type=…&active_only=false` | `views/app.html:3847`, `3848`, `3849` | `switchMenuTab` `views/app.html:12731` → `loadMenuList` `views/app.html:12741` | `views/app.html:12750` |
| Search box | Live-filters via `q=` | `GET /api/menu-items?…&q=` | `views/app.html:3853` | `loadMenuList` `views/app.html:12741` | `views/app.html:12750` |
| Add new | Opens menu-item modal in create mode | `GET /api/menu-items`, `GET /api/inventory-items` (dropdowns) | `views/app.html:3856` | `openMenuItemModal` `views/app.html:12786` | `views/app.html:12794`, `12806` |
| Row click | Opens modal in edit mode | `GET /api/menu-items/:id` | `views/app.html:12765` (template) | `openMenuItemModal` `views/app.html:12786` | `views/app.html:12817` |
| Modal: Type select | Toggles Duration / Parent / Inventory rows | client-only | `views/app.html:3932` | `onMenuItemTypeChange` `views/app.html:12779` | — |
| Modal: Tax behavior select | Sets `tax_behavior` | client-only (part of payload) | `views/app.html:3963` | `submitMenuItem` `views/app.html:12850` | `views/app.html:13188` |
| Modal: Parent service select | Required for add-ons | populated by `GET /api/menu-items?type=service` | `views/app.html:3972` | `openMenuItemModal` `views/app.html:12786` | `views/app.html:12794` |
| Modal: Linked inventory select | Optional product↔inventory link | populated by `GET /api/inventory-items` | `views/app.html:3978` | `openMenuItemModal` `views/app.html:12786` | `views/app.html:12806` |
| Modal: Archive | Archives via the `archive_menu_item` tool | `POST /api/command` | `views/app.html:3983` | `archiveMenuItem` `views/app.html:12895` → `sendAICommand` `views/app.html:13186` | `views/app.html:13188` |
| Modal: Save | Issues `update_menu_item` / `add_menu_item` via the AI bus — not REST | `POST /api/command` | `views/app.html:3985` | `submitMenuItem` `views/app.html:12850` → `sendAICommand` `views/app.html:13186` | `views/app.html:13188` |

### 1.15 `page-inventory-ps`

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| Tab: Inventory | Shows inventory body, loads items | `GET /api/inventory-items?…` | `views/app.html:3882` | `switchInventoryTab` `views/app.html:12910` → `loadInventoryList` `views/app.html:12930` | `views/app.html:12939` |
| Tab: Vendors | Shows vendor body, loads vendors | `GET /api/vendors?…` | `views/app.html:3883` | `switchInventoryTab` `views/app.html:12910` → `loadVendorList` `views/app.html:13084` | `views/app.html:13091` |
| Inventory search | Filters by `q=` | `GET /api/inventory-items?q=` | `views/app.html:3889` | `loadInventoryList` `views/app.html:12930` | `views/app.html:12939` |
| Status filter select (All / In stock / Low / Out) | Filters by three-state stock status | `GET /api/inventory-items?status=` | `views/app.html:3892` | `loadInventoryList` `views/app.html:12930` | `views/app.html:12939` |
| Add item | Opens inventory modal in create mode | `GET /api/vendors` (dropdown) | `views/app.html:3898` | `openInventoryItemModal` `views/app.html:12967` | `views/app.html:12976` |
| Inventory row click | Opens modal in edit mode | `GET /api/inventory-items/:id` | `views/app.html:12953` (template) | `openInventoryItemModal` `views/app.html:12967` | `views/app.html:12987` |
| Modal: Status select (In stock / Low / Out) | Sets three-state stock status | client-only (part of payload) | `views/app.html:4006` | `submitInvItem` `views/app.html:13015` | `views/app.html:13188` |
| Modal: Preferred vendor select | Vendor used for restock messaging | populated by `GET /api/vendors` | `views/app.html:4025` | `openInventoryItemModal` `views/app.html:12967` | `views/app.html:12976` |
| Modal: Archive (inventory) | Archives the item via REST | `POST /api/inventory-items/:id/archive` | `views/app.html:4034` | `archiveInvItem` `views/app.html:13056` | `views/app.html:13061` |
| Modal: Message vendor for restock | Drafts a restock message via the tool (lands in approval queue) | `POST /api/command` | `views/app.html:4035` | `restockFromInventory` `views/app.html:13068` → `sendAICommand` `views/app.html:13186` | `views/app.html:13188` |
| Modal: Save (inventory) | `update_inventory_status` / `add_inventory_item` via the AI bus | `POST /api/command` | `views/app.html:4037` | `submitInvItem` `views/app.html:13015` | `views/app.html:13188` |
| Vendor search | Filters vendors by `q=` | `GET /api/vendors?q=` | `views/app.html:3908` | `loadVendorList` `views/app.html:13084` | `views/app.html:13091` |
| Add vendor | Opens vendor modal in create mode | client-only (no fetch on create path) | `views/app.html:3911` | `openVendorModal` `views/app.html:13113` | — |
| Vendor row click | Opens vendor modal in edit mode | `GET /api/vendors/:id` | `views/app.html:13102` (template) | `openVendorModal` `views/app.html:13113` | `views/app.html:13119` |
| Modal: Archive (vendor) | Archives the vendor via REST | `POST /api/vendors/:id/archive` | `views/app.html:4068` | `archiveVendor` `views/app.html:13171` | `views/app.html:13176` |
| Modal: Save (vendor) | `update_vendor` / `add_vendor` via the AI bus | `POST /api/command` | `views/app.html:4070` | `submitVendor` `views/app.html:13143` | `views/app.html:13188` |

### 1.16 Cross-cutting modals (onboarding, plan, consent)

| Action | What it does | Endpoint | HTML line | Handler | Fetch |
|---|---|---|---|---|---|
| Upgrade Plan (upgradePromptModal) | Opens Stripe billing portal | `POST /api/billing/portal-session` | `views/app.html:13524` | `openBillingPortal` `views/app.html:8609` | `views/app.html:8611` |
| Maybe Later | Dismisses the upgrade modal | client-only | `views/app.html:13523` | `closeUpgradePrompt` `views/app.html:8658` | — |
| Onboarding step 1 Continue | Saves property name locally, advances | client-only | `views/app.html:13544` | `obNext` `views/app.html:8043` | — |
| Onboarding step 2 Continue / Skip | Saves notification email if entered | `PUT /api/settings` | `views/app.html:13553`, `13554` | `obNext` `views/app.html:8043` | `views/app.html:8055` → `4470` |
| "Set up my business →" | Marks onboarding complete | `PUT /api/me/onboarding` | `views/app.html:13562` | `finishOnboarding` `views/app.html:8065` | `views/app.html:8066` → `4470` |
| Consent checkbox (autoReplyConsentModal) | Enables the confirm button | client-only | `views/app.html:13974` | `updateAutoReplyConsentBtn` `views/app.html:5047` | — |
| Enable Auto-Reply | Records consent, turns on AI auto-reply | `POST /api/automation/consent` | `views/app.html:13980` | `submitAutoReplyConsent` `views/app.html:5055` | `views/app.html:5059` |
| Event modal: "Also add this as a Task" checkbox | Additionally creates a task on submit | `POST /api/tasks` (when checked) | `views/app.html:14011` | `submitAddEvent` `views/app.html:6562` | `views/app.html:6585` → `4470` |
| Block-off modal: "Whole day" checkbox | Shows/hides the time row | client-only | `views/app.html:14055` | `onBlockOffWholeDayChange` `views/app.html:5987` | — |
| Block-off modal: Block off | Expands a range into one POST per day (31-day cap) | `POST /api/calevents` ×N | `views/app.html:14077` | `submitBlockOff` `views/app.html:5995` | `views/app.html:6035` |
| Cancel / Close / overlay dismiss (all 24 modals) | Closes without side effects | client-only | grouped — see note | various | — |

**Grouping note:** every modal carries a Cancel button and an overlay click-out that are pure UI. There are 24 such modals (`views/app.html:3926`, `3991`, `4043`, `4076`, `4091`, `4109`, `4126`, `4146`, `13518`, `13529`, `13567`, `13632`, `13676`, `13752`, `13812`, `13894`, `13934`, `13953`, `13986`, `14036`, `14083`, `14121`, `14148`, `14175`). They are counted as **one** grouped row above rather than 48 individual rows, and are excluded from the Section 3 parity table since closing a dialog is not an ownable intent.

---

## 2. TOOL INVENTORY

53 tools are registered. The list is authoritative from `lib/tools/index.js:7`–`79` (each `require()` line triggers a `registry.register()` call), cross-checked against a glob of `lib/tools/*.js` (54 files, minus `index.js`).

### 2.1 The two exposure paths

**Owner command bar.** `/api/command` is defined at `server.js:4799`. It resolves the workspace row at `server.js:4808`–`4815`, the vertical at `server.js:4867`, and the plan at `server.js:4941`. It then builds its tool list with:

```
const toolsForAI = registry.getAnthropicSchemaForPlan(vertical, planForTools);   // server.js:4942
```

`getAnthropicSchemaForPlan` (`lib/tool-registry.js:100`) delegates to `getToolsForPlan` (`lib/tool-registry.js:90`), which applies the vertical filter of `getToolsForVertical` (`lib/tool-registry.js:64` — admits `vertical === 'core'` or an exact vertical match, `lib/tool-registry.js:67`) and then the plan-feature filter driven by `TOOL_REQUIRED_FEATURE` (`lib/tool-registry.js:27`–`29`). That map has exactly one entry today: `send_broadcast: 'broadcast'` (`lib/tool-registry.js:28`). **Every other tool matching the workspace's vertical is exposed to the owner command bar with no further gating.** The resulting list is passed as `tools:` on every turn of the agentic loop at `server.js:5036`, and `requiresApproval` tools are diverted to `pending_actions` instead of executing at `server.js:5083`–`5118`.

**Customer-facing engine.** `lib/appointment-engine.js:41`–`48` defines the customer allowlist:

```
const APPOINTMENT_TOOL_NAMES = [
  'book_appointment',
  'update_appointment',
  'cancel_appointment',
  'propose_appointment_times',
  'escalate_appointment_to_owner',
  'add_task',
];
```

`buildToolListForEngine` (`lib/appointment-engine.js:353`) applies the same vertical+plan filter and then intersects with that array at `lib/appointment-engine.js:356`. It is called at `lib/appointment-engine.js:92`. Tool execution runs at `lib/appointment-engine.js:396` with a context whose `origin.channel` is hardcoded to `'ai_inbound'` (`lib/appointment-engine.js:390`) and whose `user.id` is the workspace owner (`lib/appointment-engine.js:377`).

`requiresApproval` defaults to `false` when a tool omits it (`lib/tool-registry.js:52`). 25 of the 53 tool files omit it entirely. Only 8 tools set it true: `compose_message`, `message_vendor_for_restock`, `reply_to_message`, `request_payments_batch`, `send_broadcast`, `send_email`, `send_late_notice`, `send_sms`. **Critically, the appointment engine never consults `requiresApproval` at all** — `lib/appointment-engine.js:396` calls `tool.execute()` unconditionally, with no equivalent of the `server.js:5083` diversion.

### 2.2 The 53 tools

Key: **O** = reachable from the owner command bar; **C** = also reachable from the customer engine.

| # | Tool | What it does | vertical | category | reqApproval | Exposure | Touches |
|---|---|---|---|---|---|---|---|
| 1 | `add_calendar_event` | Adds a calendar event; `time_off` blocks make slots unbookable | `core` `:36` | `create` `:37` | false (default, `lib/tool-registry.js:52`) | O only — deliberately absent from allowlist per `lib/appointment-engine.js:38`–`40` | `cal_events` INSERT `:110` |
| 2 | `delete_calendar_event` | Deletes a calendar event by fuzzy title match | `core` `:7` | `delete` `:8` | false (default) | O | `cal_events` SELECT `:26`, DELETE `:39` |
| 3 | `add_task` | Creates a task on the owner's task list | `core` `:18` | `create` `:19` | false (default) | **O + C** (`lib/appointment-engine.js:47`) | `tasks` INSERT `lib/tools/add_task.js:41` |
| 4 | `update_task` | Changes a task's status/title/due date/category/notes | `core` `:11` | `update` `:12` | false (default) | O | `tasks` |
| 5 | `add_contact` | Adds a contact (resident, vendor, staff, important) | `core` `:11` | `create` `:12` | false (default) | O | `contacts` |
| 6 | `update_contact` | Updates phone, email, lease dates, rent, notes, type | `core` `:11` | `update` `:12` | false (default) | O | `contacts` |
| 7 | `add_budget_transaction` | Logs an income/expense row in the budget tracker | `property-management` `:13` | `financial` `:14` | false (default) | O (PM) | `budget` |
| 8 | `add_maintenance_ticket` | Creates a maintenance ticket | `property-management` `:36` | `create` `:37` | false (default) | O (PM) | `maintenance` |
| 9 | `compose_message` | Composes and saves a message to the inbox | `core` `:16` | `create` `:16` | **true** `:28` | O | `messages` |
| 10 | `mark_rent_paid` | Marks a resident's rent paid by name/unit fuzzy match | `property-management` `:15` | `financial` `:16` | false (default) | O (PM) | `rent` |
| 11 | `send_late_notice` | Sends a late-payment notice to a resident | `property-management` `:18` | `external-facing` `:19` | **true** `:30` | O (PM) | `rent`, Twilio/SendGrid |
| 12 | `generate_rent` | Bulk-creates pending rent records for all residents | `property-management` `:14` | `financial` `:14` | false (default) | O (PM) | `rent` |
| 13 | `create_property` | Creates a property (building/location) | `property-management` `:11` | `create` `:11` | false (default) | O (PM) | `entities` |
| 14 | `update_property` | Updates fields on an existing property | `property-management` `:12` | `update` `:12` | false (default) | O (PM) | `entities` |
| 15 | `archive_property` | Soft-deletes (archives) a property | `property-management` `:12` | `delete` `:12` | false (default) | O (PM) | `entities` |
| 16 | `create_unit` | Creates a unit within a property | `property-management` `:21` | `create` `:21` | false (default) | O (PM) | `offerings` |
| 17 | `update_unit` | Updates fields on an existing unit | `property-management` `:15` | `update` `:15` | false (default) | O (PM) | `offerings` |
| 18 | `set_unit_off_market` | Toggles a unit on/off market without ending tenancy | `property-management` `:14` | `update` `:14` | false (default) | O (PM) | `offerings` |
| 19 | `retire_unit` | Soft-deletes (retires) a unit permanently | `property-management` `:12` | `delete` `:12` | false (default) | O (PM) | `offerings` |
| 20 | `assign_tenant_to_unit` | Creates an active engagement linking contact → unit | `property-management` `:20` | `create` `:20` | false (default) | O (PM) | `engagements` |
| 21 | `move_tenant_to_unit` | Atomically ends the old engagement, creates a new one | `property-management` `:23` | `update` `:23` | false (default) | O (PM) | `engagements` |
| 22 | `end_tenant_assignment` | Terminates a tenant's active engagement | `property-management` `:16` | `update` `:16` | false (default) | O (PM) | `engagements` |
| 23 | `generate_report` | Generates and saves a written report | `core` `:18` | `create` `:18` | false (default) | O | `reports` |
| 24 | `update_maintenance_ticket` | Changes ticket status/title/description/unit/resident | `property-management` `:13` | `update` `:13` | false (default) | O (PM) | `maintenance` |
| 25 | `resolve_maintenance_ticket` | Closes a ticket with an optional resolution note | `property-management` `:13` | `update` `:13` | false (default) | O (PM) | `maintenance` |
| 26 | `add_invoice` | Creates a vendor invoice record | `property-management` `:14` | `financial` `:14` | false (default) | O (PM) | `invoices` |
| 27 | `update_invoice_status` | Marks an invoice paid/overdue/cancelled by fuzzy match | `property-management` `:12` | `financial` `:12` | false (default) | O (PM) | `invoices` |
| 28 | `send_sms` | Sends a real SMS to a contact via Twilio | `core` `:23` | `external-facing` `:24` | **true** `:35` | O | `contacts`, Twilio |
| 29 | `send_email` | Sends a real email to a contact via SendGrid | `core` `:22` | `external-facing` `:23` | **true** `:35` | O | `contacts`, SendGrid |
| 30 | `send_broadcast` | Sends one message to many recipients | `property-management` `:29` | `external-facing` `:30` | **true** `:43` | O (PM) — **plan-gated** on `broadcast` (`lib/tool-registry.js:28`) | `contacts`, Twilio/SendGrid |
| 31 | `reply_to_message` | Replies to an inbox message; channel auto-detected | `core` `:26` | `external-facing` `:27` | **true** `:39` | O | `messages`, Twilio/SendGrid |
| 32 | `book_appointment` | Books an appointment + linked calendar event | `professional-services` `:22` | `create` `:23` | false `:40` | **O + C** (`lib/appointment-engine.js:42`) | `appointments` INSERT `:114`, `cal_events`, `appointment_threads` `:149` |
| 33 | `update_appointment` | Reschedules / edits an appointment by id | `professional-services` `:12` | `update` `:13` | false `:29` | **O + C** (`lib/appointment-engine.js:43`) | `appointments` UPDATE `:89`, `cal_events` UPDATE `:100` |
| 34 | `cancel_appointment` | Sets an appointment to canceled with reason/actor | `professional-services` `:11` | `update` `:12` | false `:24` | **O + C** (`lib/appointment-engine.js:44`) | `appointments` UPDATE `:43` |
| 35 | `complete_appointment` | Marks completed, records payment, drafts a transaction | `professional-services` `:21` | `update` `:22` | false `:36` | O only | `appointments` UPDATE `:54`, `transactions` |
| 36 | `propose_appointment_times` | Suggests 2–3 open slots avoiding conflicts; books nothing | `professional-services` `:18` | `read` `:19` | false `:31` | **O + C** (`lib/appointment-engine.js:45`) | `cal_events` SELECT `:56` (read-only) |
| 37 | `escalate_appointment_to_owner` | Flags a thread for owner review + creates a follow-up task | `professional-services` `:15` | `update` `:16` | false `:27` | **O + C** (`lib/appointment-engine.js:46`) | `appointment_threads`, `tasks` |
| 38 | `create_transaction` | Records a sale/walk-in not tied to an appointment | `professional-services` `:28` | `create` `:28` | false `:60` | O | `transactions` |
| 39 | `update_transaction` | Edits a draft/pending transaction's line items and totals | `professional-services` `:20` | `update` `:20` | false `:49` | O | `transactions` |
| 40 | `complete_transaction` | Marks paid, stamps payment, triggers a receipt send | `professional-services` `:18` | `update` `:18` | false `:32` | O | `transactions`, receipts |
| 41 | `void_transaction` | Voids a draft/pending/unpaid transaction | `professional-services` `:15` | `delete` `:15` | false `:26` | O | `transactions` |
| 42 | `find_transaction` | Searches transactions by customer, method, date, amount | `professional-services` `:18` | `read` `:18` | false `:34` | O | `transactions` (read-only) |
| 43 | `find_outstanding_balance` | Finds what a customer owes / who owes money | `professional-services` `:22` | `read` `:22` | false `:33` | O | `transactions` (read-only) |
| 44 | `request_payments_batch` | Texts Stripe Checkout payment links to customers who owe | `professional-services` `:41` | `external-facing` `:41` | **true** `:44` | O | `transactions`, `payment_requests`, Stripe |
| 45 | `add_menu_item` | Adds a service, product, or add-on to the menu | `professional-services` `:15` | `create` `:15` | false `:33` | O | `menu_items` |
| 46 | `update_menu_item` | Updates a menu item (not type or parent) | `professional-services` `:13` | `update` `:13` | false `:31` | O | `menu_items` |
| 47 | `archive_menu_item` | Soft-deletes a menu item; cascades to its add-ons | `professional-services` `:14` | `delete` `:14` | false `:24` | O | `menu_items` |
| 48 | `update_inventory_status` | Sets stock status (in_stock/low/out) and quantity | `professional-services` `:17` | `update` `:17` | false `:30` | O | `inventory_items` |
| 49 | `add_inventory_item` | Starts tracking a new supply/product | `professional-services` `:25` | `create` `:25` | false `:41` | O | `inventory_items` |
| 50 | `add_vendor` | Adds a supplier with at least one contact channel | `professional-services` `:14` | `create` `:14` | false `:28` | O | `vendors` |
| 51 | `update_vendor` | Updates a vendor's name, phone, email, URL, notes | `professional-services` `:12` | `update` `:12` | false `:27` | O | `vendors` |
| 52 | `message_vendor_for_restock` | Drafts and sends a restock message to a vendor | `professional-services` `:22` | `external-facing` `:22` | **true** `:38` | O | `vendors`, `inventory_items`, Twilio/SendGrid |
| 53 | `find_menu_item` | Searches the menu by free text, type, category | `professional-services` `:13` | `read` `:13` | false `:25` | O | `menu_items` (read-only) |

Line citations in the vertical/category/reqApproval columns are relative to each tool's own file in `lib/tools/`.

---

## 3. THE PARITY TABLE

Verdicts against the tool inventory in Section 2. Pure-navigation actions (nav items, stat tiles, breadcrumbs, "See all →" links, tab switches, modal Cancel/Close) are excluded — an assistant panel makes navigation moot, and scoring them would inflate the parity number. Client-only filters and searches ARE scored, because "show me only unpaid rent" is a real thing an owner asks.

### 3.1 Verdicts

| # | Screen | Action | Verdict | Tool / what's missing |
|---|---|---|---|---|
| 1 | shell | Command center: Send prompt | MATCH | is the AI path itself (`views/app.html:13395` → `server.js:4799`) |
| 2 | shell | Sign Out | NO TOOL | no session tool exists |
| 3 | shell | Manage Billing / Upgrade Plan | NO TOOL | no billing tool; `POST /api/billing/portal-session` unreachable by ask |
| 4 | home-pm | Change Photo | NO TOOL | localStorage-only (`views/app.html:9732`) |
| 5 | home-pm | Edit Name | NO TOOL | localStorage-only (`views/app.html:9743`) |
| 6 | home-pm | Generate Snapshot | MATCH | `generate_report` |
| 7 | home-pm | Approve pending action (queue + chip) | NO TOOL | nothing exposes `POST /api/pending-actions/:id/approve`; the AI cannot approve its own queue |
| 8 | home-pm | Reject pending action (queue + chip) | NO TOOL | same |
| 9 | home-ps | Approve / Reject (PS approvals) | NO TOOL | same as #7/#8 |
| 10 | inbox | Switch folder (inbox/archive/deleted) | NO TOOL | no message-read/filter tool |
| 11 | inbox | Empty Trash | NO TOOL | no bulk message-delete tool |
| 12 | inbox | Open message | NO TOOL | no message-read tool |
| 13 | inbox | Archive message | NO TOOL | no message-folder tool |
| 14 | inbox | Restore message | NO TOOL | same |
| 15 | inbox | Delete message (soft) | NO TOOL | same |
| 16 | inbox | Delete Forever | NO TOOL | same |
| 17 | inbox | Mark emergency reviewed | NO TOOL | nothing hits `POST /api/messages/:id/clear-emergency` |
| 18 | inbox | Generate AI Draft | NO TOOL | `POST /api/generate` has no tool wrapper |
| 19 | inbox | Reply via SMS | MATCH | `reply_to_message` (auto-detects channel, `lib/tools/reply_to_message.js:25`) |
| 20 | inbox | Reply via Email | MATCH | `reply_to_message` |
| 21 | inbox | Send Reply (per draft) | PARTIAL | `reply_to_message` sends a reply, but cannot send *a specific stored draft by id* — it composes fresh text |
| 22 | inbox | Copy draft | NO TOOL | clipboard, not ownable |
| 23 | operations | Set automation mode (auto-reply / manager review) | NO TOOL | nothing exposes `PUT /api/automation` or `POST /api/automation/consent` |
| 24 | operations | Test email connection | NO TOOL | no email-account tool |
| 25 | operations | Connect & Save mailbox | NO TOOL | same |
| 26 | operations | Sync now | NO TOOL | same |
| 27 | operations | Disconnect mailbox | NO TOOL | same |
| 28 | operations | Add knowledge document | NO TOOL | nothing exposes `POST /api/knowledge` — the engine *reads* knowledge (`lib/appointment-engine.js:160`) but no tool writes it |
| 29 | operations | Upload knowledge file | NO TOOL | same |
| 30 | operations | Remove knowledge document | NO TOOL | same |
| 31 | calendar | Prev / Next / Today / Month / Year navigation | NO TOOL | view state has no tool; the panel should read it as context (Section 5) rather than mutate it |
| 32 | calendar | Switch view (Day/Week/Month/Year) | NO TOOL | same |
| 33 | calendar | Add Event | MATCH | `add_calendar_event` |
| 34 | calendar | Block off time (single day) | MATCH | `add_calendar_event` with `event_type:'time_off'` (`lib/tools/add_calendar_event.js:46`) |
| 35 | calendar | Block off time (multi-day range) | PARTIAL | UI expands a range into one POST per day up to 31 (`views/app.html:6035`); the tool requires one call per day by design (`lib/tools/add_calendar_event.js:35`), so a 3-week block is 21 tool calls against a 5-iteration agentic cap (`server.js:5021`) |
| 36 | calendar | Delete calendar event (day panel ✕, modal Delete) | PARTIAL | `delete_calendar_event` matches by fuzzy **title**, not id (`lib/tools/delete_calendar_event.js:15`), silently deletes the first of up to 5 matches (`:37`, `:42`), and scopes by `user_id` not `workspace_id` (`:26`, `:39`) |
| 36b | calendar | Remove time-off block | PARTIAL | same tool, same title-matching limitation; time-off titles are frequently duplicated ("Time off") |
| 37 | calendar | Toggle task done (day panel) | MATCH | `update_task` |
| 38 | calendar | Delete task (day panel) | PARTIAL | `update_task` cannot delete; no `delete_task` tool exists |
| 39 | calendar | Add Task on date | MATCH | `add_task` |
| 40 | calendar | Create follow-up task from event | MATCH | `add_task` |
| 41 | calendar | Edit / Save appointment (reschedule, price) | MATCH | `update_appointment` (`quoted_price_cents` at `lib/tools/update_appointment.js:23`) |
| 42 | calendar | Cancel appointment | MATCH | `cancel_appointment` |
| 43 | calendar | Task detail Complete | MATCH | `update_task` |
| 44 | reports | Filter reports by type | NO TOOL | no report-read tool |
| 45 | reports | New Report | MATCH | `generate_report` |
| 46 | reports | Open report | NO TOOL | no report-read tool |
| 47 | reports | Delete report | NO TOOL | no report-delete tool |
| 48 | contacts | Search / filter by type | NO TOOL | no contact-read tool; contacts arrive via the snapshot (`server.js:4917` region) not a tool |
| 49 | contacts | Import CSV | NO TOOL | no bulk-import tool |
| 50 | contacts | Broadcast | MATCH (PM) / NO TOOL (PS) | `send_broadcast` is `vertical:'property-management'` (`lib/tools/send_broadcast.js:29`), so `getToolsForVertical` (`lib/tool-registry.js:67`) hides it from PS workspaces even though the Broadcast button renders on `page-contacts` for both |
| 51 | contacts | Add Contact | MATCH | `add_contact` |
| 52 | contacts | Edit Contact | MATCH | `update_contact` |
| 53 | contacts | Remove Contact | NO TOOL | no `delete_contact` tool |
| 54 | contacts | Compose Message (detail pane) | PARTIAL | `compose_message` writes to `messages`; the UI handler pushes to a local array only and never fetches (`views/app.html:7506`) — the tool is *more* capable than the button |
| 55 | contacts | Assign unit / reconcile engagement on save | MATCH | `assign_tenant_to_unit` / `move_tenant_to_unit` / `end_tenant_assignment` |
| 56 | inventory-pm | Add Property | MATCH | `create_property` |
| 57 | inventory-pm | Edit / Save property | MATCH | `update_property` |
| 58 | inventory-pm | Archive property | MATCH | `archive_property` |
| 59 | inventory-pm | Add Unit | MATCH | `create_unit` |
| 60 | inventory-pm | Edit / Save unit | MATCH | `update_unit` |
| 61 | inventory-pm | Retire unit | MATCH | `retire_unit` |
| 62 | inventory-pm | Set unit off-market (via unit edit form) | MATCH | `set_unit_off_market` |
| 63 | tasks | Filter (All/Pending/Done/Overdue) | NO TOOL | no task-read tool |
| 64 | tasks | Add Task | MATCH | `add_task` |
| 65 | tasks | Approve AI-suggested task | NO TOOL | nothing exposes `PUT /api/tasks/:id/approve` |
| 66 | tasks | Reject AI-suggested task | NO TOOL | nothing exposes `DELETE /api/tasks/:id/reject` |
| 67 | tasks | Toggle task done | MATCH | `update_task` |
| 68 | tasks | Delete task | NO TOOL | no `delete_task` tool |
| 69 | maintenance | Filter by status | NO TOOL | no maintenance-read tool |
| 70 | maintenance | New Ticket | MATCH | `add_maintenance_ticket` |
| 71 | maintenance | Quick status change | MATCH | `update_maintenance_ticket` |
| 72 | maintenance | Update / Resolve ticket | MATCH | `resolve_maintenance_ticket` |
| 73 | maintenance | Edit resolved ticket | MATCH | `update_maintenance_ticket` |
| 74 | maintenance | Delete ticket | NO TOOL | no maintenance-delete tool (`update_maintenance_ticket` can set status `cancelled`, `lib/tools/update_maintenance_ticket.js:11`, but the row survives) |
| 75 | admin | Email notifications toggle | NO TOOL | nothing exposes `PUT /api/settings` |
| 76 | admin | Push notifications toggle | NO TOOL | same |
| 77 | admin | Save notification settings (email + alert phone) | NO TOOL | same |
| 78 | admin | Track inventory toggle | NO TOOL | nothing exposes `POST /api/workspace/inventory-tracking` |
| 79 | admin | Copy forwarding address | NO TOOL | clipboard, not ownable |
| 80 | admin | Refresh payment events | NO TOOL | no payment-event tool |
| 81 | admin | Run AI Match | NO TOOL | same |
| 82 | admin | Confirm payment match | NO TOOL | same |
| 83 | admin | Dismiss payment event | NO TOOL | same |
| 84 | admin | Rent month / year filter | NO TOOL | no rent-read tool |
| 85 | admin | Generate Month (rent) | MATCH | `generate_rent` |
| 86 | admin | Add rent record manually | NO TOOL | `generate_rent` is bulk-only (`lib/tools/generate_rent.js:12`); no single-record create |
| 87 | admin | Mark Paid (rent row) | MATCH | `mark_rent_paid` |
| 88 | admin | Send Notice (rent row) | MATCH | `send_late_notice` |
| 89 | admin | Delete rent record | NO TOOL | no rent-delete tool |
| 90 | admin | Add Invoice | MATCH | `add_invoice` |
| 91 | admin | Approve / Reject / Reset invoice | MATCH | `update_invoice_status` |
| 92 | admin | Delete invoice | NO TOOL | `update_invoice_status` can set `cancelled` but not delete |
| 93 | admin | Budget month / year filter | NO TOOL | no budget-read tool |
| 94 | admin | Budget type filter (income/expenses) | NO TOOL | same |
| 95 | admin | Add budget transaction | MATCH | `add_budget_transaction` |
| 96 | admin | Delete budget transaction | NO TOOL | no budget-delete tool |
| 97 | finances | Set up card payments (Stripe Connect) | NO TOOL | no Connect-onboarding tool |
| 98 | finances | Search transactions | MATCH | `find_transaction` (`lib/tools/find_transaction.js:16`) |
| 99 | finances | Customer / date / method / status filters | MATCH | `find_transaction` schema covers all four (`lib/tools/find_transaction.js:16`) |
| 100 | finances | Refresh transactions | MATCH | `find_transaction` |
| 101 | finances | Export CSV | NO TOOL | no export tool |
| 102 | finances | New transaction | MATCH | `create_transaction` — the UI itself routes through it (`views/app.html:12209`) |
| 103 | finances | Open transaction detail | MATCH | `find_transaction` returns summaries; sufficient to answer "show me Maria's last sale" |
| 104 | finances | Send / Resend receipt | PARTIAL | `complete_transaction` triggers a receipt on completion (`lib/tools/complete_transaction.js:16`); nothing re-sends a receipt for an already-paid transaction |
| 105 | finances | Issue refund | NO TOOL | no refund tool; `void_transaction` explicitly refuses paid transactions (`lib/tools/void_transaction.js:13`) |
| 106 | finances | Request deposit | PARTIAL | `request_payments_batch` sends payment links but has no `payment_type:'deposit'` concept (`lib/tools/request_payments_batch.js:39`) |
| 107 | finances | Request payment | MATCH | `request_payments_batch` |
| 108 | finances | Void transaction | MATCH | `void_transaction` — the UI routes through it (`views/app.html:12125`) |
| 109 | my-business | Save business description / hours / policies | NO TOOL | writes to `/api/knowledge`; no knowledge-write tool exists |
| 110 | my-business | Save Services (grid) | MATCH | `add_menu_item` / `update_menu_item` |
| 111 | my-business | Remove service row | MATCH | `archive_menu_item` |
| 112 | my-business | Save Products (grid) | MATCH | `add_menu_item` / `update_menu_item` |
| 113 | my-business | Remove product row | MATCH | `archive_menu_item` |
| 114 | my-business | Toggle "assistant may reply on its own" | NO TOOL | nothing exposes `PATCH /api/workspace/ai-settings` |
| 115 | my-business | Toggle "assistant may book automatically" | NO TOOL | same — yet `appointment_auto_confirm` decides whether bookings land `confirmed` or `requested` (`lib/tools/book_appointment.js:108`) |
| 116 | my-business | Tone select | NO TOOL | same endpoint; `ai_tone` read at `lib/appointment-engine.js:326` |
| 117 | my-business | Sales approach select | NO TOOL | same; `ai_sales_posture` read at `lib/appointment-engine.js:340` |
| 118 | my-business | Save growth links (website / Google / Yelp) | NO TOOL | knowledge rows again |
| 119 | menu | Tab: Services / Products / Add-ons | MATCH | `find_menu_item` filters by type (`lib/tools/find_menu_item.js:11`) |
| 120 | menu | Search menu | MATCH | `find_menu_item` |
| 121 | menu | Add new menu item | MATCH | `add_menu_item` — the UI routes through it (`views/app.html:13188`) |
| 122 | menu | Edit menu item | MATCH | `update_menu_item` |
| 123 | menu | Archive menu item | MATCH | `archive_menu_item` |
| 124 | inventory-ps | Tab: Inventory / Vendors | NO TOOL | no inventory-read or vendor-read tool exists |
| 125 | inventory-ps | Search inventory | NO TOOL | same — `find_menu_item` covers the menu, nothing covers stock |
| 126 | inventory-ps | Status filter (in_stock / low / out) | NO TOOL | same; "what am I low on?" has no tool |
| 127 | inventory-ps | Add item | MATCH | `add_inventory_item` |
| 128 | inventory-ps | Edit item / set status + quantity | MATCH | `update_inventory_status` |
| 129 | inventory-ps | Archive inventory item | NO TOOL | `POST /api/inventory-items/:id/archive` has no tool wrapper |
| 130 | inventory-ps | Message vendor for restock | MATCH | `message_vendor_for_restock` — the UI routes through it (`views/app.html:13188`) |
| 131 | inventory-ps | Search vendors | NO TOOL | no vendor-read tool |
| 132 | inventory-ps | Add vendor | MATCH | `add_vendor` |
| 133 | inventory-ps | Edit vendor | MATCH | `update_vendor` |
| 134 | inventory-ps | Archive vendor | NO TOOL | `POST /api/vendors/:id/archive` has no tool wrapper |
| 135 | modals | Onboarding steps / finish | NO TOOL | no onboarding tool |
| 136 | modals | Enable Auto-Reply (consent) | NO TOOL | same as #23 |
| 137 | modals | "Also add this as a Task" on event create | MATCH | `add_task` alongside `add_calendar_event` — the command bar prompt explicitly supports multi-tool turns (`server.js:4982`) |

### 3.2 Tools with no UI equivalent

These are fine — they exist for conversational surfaces or for reach the UI never gave the owner. Noted, not faulted.

| Tool | Why it has no UI counterpart |
|---|---|
| `propose_appointment_times` | Pure availability reasoning for the customer engine (`lib/appointment-engine.js:45`); the calendar shows the grid instead |
| `escalate_appointment_to_owner` | Customer-engine-only escape hatch (`lib/appointment-engine.js:46`); nothing in the SPA escalates a thread |
| `complete_appointment` | No "mark complete" control exists on the calendar — verified across `renderCalEventDetail` `views/app.html:6254`–`6325`. This is a UI gap, not a tool gap |
| `book_appointment` | The owner cannot book an appointment by clicking anywhere; `+ Add Event` (`views/app.html:2735`) creates a `cal_events` row with no `appointments` row. Only the AI can create real appointments |
| `find_outstanding_balance` | No "who owes me money" screen exists; the closest is the status filter on Finances (`views/app.html:3516`) |
| `update_transaction` | The transaction detail modal (`views/app.html:4076`) has no edit mode — only receipt/refund/payment/void |
| `complete_transaction` | No "mark paid" button on the transaction modal; only refund and void |
| `move_tenant_to_unit` | The UI reconciles engagements implicitly via the unit dropdown (`views/app.html:10547`); there is no explicit "move tenant" control |
| `send_sms` / `send_email` | The inbox only replies to existing threads (`views/app.html:4631`, `4632`); cold outbound to a contact has no button |
| `compose_message` | See parity row #54 — the tool persists, the button does not |

### 3.3 Summary counts

Scored actions: **138** (137 numbered rows, with row 36 split into 36 and 36b).

| Verdict | Count | Share |
|---|---|---|
| MATCH | 56 | 40.6% |
| PARTIAL | 7 | 5.1% |
| NO TOOL | 75 | 54.3% |

**Full parity: 40.6%** (56/138). Counting PARTIAL as partial credit at half weight gives 43.1%.

The distribution is not uniform. Parity is strong on the CRUD spine — properties, units, contacts, tasks, menu, appointments — and collapses on three clusters: **settings/config** (rows 23–30, 75–78, 109, 114–118: 0 of 17 covered), **read/filter operations** (rows 44, 48, 63, 69, 84, 93–94, 124–126, 131: 0 of 12 covered), and **deletes** (rows 38, 53, 68, 74, 89, 92, 96, 129, 134: 0 of 9 covered).

---

## 4. BOUNDARY REVIEW

### 4.1 The CP6 precedent

`add_calendar_event` was removed from the customer allowlist because it can create `time_off` blocks, which are owner-only. The removal is documented in place:

```
// CP6: add_calendar_event is deliberately ABSENT — it can create
// time_off blocks, which are owner-only. Customers book through
// book_appointment; they must never reach calendar-writing tools.
```
— `lib/appointment-engine.js:38`–`40`

A second, independent refusal was added inside the tool itself:

```
// CP6 belt-and-suspenders: the customer-facing engine no longer
// lists this tool at all, but even if an allowlist drifts, an
// inbound customer conversation can never create calendar entries.
if (ctx.origin && ctx.origin.channel === 'ai_inbound') {
  return { success: false, message: 'Only the business owner can add calendar entries or block off time. …' };
}
```
— `lib/tools/add_calendar_event.js:73`–`78`

The guard is reachable because the engine stamps `origin.channel = 'ai_inbound'` on every tool context it builds (`lib/appointment-engine.js:390`), while `/api/command` builds a context with **no `origin` key at all** (`server.js:4999`–`5009`) — so the owner path passes the guard by absence.

**This is the only tool in `lib/tools/` with an `ai_inbound` refusal.** A grep for `ctx.origin` across all 53 tools returns four hits: the refusal at `lib/tools/add_calendar_event.js:76`, and three *non-security* reads — `book_appointment.js:110` (picks a `source` label), `book_appointment.js:149` (links the thread), `escalate_appointment_to_owner.js:30` (defaults the thread id). None of the other five customer-reachable tools defends itself.

### 4.2 Placement review of the five customer-reachable tools

| Tool | Correctly placed? | Assessment |
|---|---|---|
| `propose_appointment_times` | **Yes** | Read-only. Its only query is a `SELECT` over `cal_events` (`lib/tools/propose_appointment_times.js:56`–`64`). It leaks nothing beyond slot availability — no titles, no customer names. Correct. |
| `book_appointment` | **Yes** | Creating a booking is the entire product. It respects `appointment_auto_confirm` so unconfirmed workspaces get `status:'requested'` rather than a confirmed slot (`lib/tools/book_appointment.js:108`), and it stamps `source:'ai_inbound_sms'` for provenance (`:110`). Correct. |
| `escalate_appointment_to_owner` | **Yes** | Escalation is a customer-safe action by construction — it only ever increases owner oversight. Correct. |
| `add_task` | **Yes, with a caveat** | Intentional: the system prompt instructs the AI to use it for callback requests (`lib/appointment-engine.js:309`). But it writes to the owner's task list with no origin guard and no rate limit (`lib/tools/add_task.js:40`–`45`), and `title`/`notes` are free-text straight from the customer's SMS. A hostile texter can enqueue unlimited arbitrary-content rows on the owner's task list. Low severity, real. |
| `update_appointment` | **NO** — see 4.3 | |
| `cancel_appointment` | **NO** — see 4.3 | |

### 4.3 FLAG: customer-reachable tools that mutate owner data without ownership verification

This is the headline finding.

`cancel_appointment` is in the customer allowlist (`lib/appointment-engine.js:44`). Its schema requires only `appointment_id` (`lib/tools/cancel_appointment.js:20`). Its lookup is:

```
const found = await ctx.db.query(
  `SELECT * FROM appointments WHERE id = $1 AND workspace_id = $2`,
  [appointment_id, ctx.workspace.id]
);
```
— `lib/tools/cancel_appointment.js:29`–`32`

The only scope is `workspace_id`. There is **no comparison against the calling customer's `contact_id`**, even though the engine has that identity available and puts it in the context at `lib/appointment-engine.js:392` (`origin.contact_id`), alongside `customer_phone` and `customer_email` at `lib/appointment-engine.js:387`–`388`. The tool never reads any of them. The `UPDATE` at `lib/tools/cancel_appointment.js:42`–`51` re-scopes by `workspace_id` only, and `canceled_by` is a free-text enum supplied by the model (`:18`, `:50`) — it records who the AI *claims* canceled, not who actually did.

**Consequence:** any customer who texts a professional-services workspace with `appointment_auto_respond` enabled can cancel *any* appointment in that workspace, belonging to *any* customer, by getting the model to pass a different integer. `appointment_id` is a sequential integer primary key, so enumeration is trivial — "cancel appointment 41", "cancel appointment 42". Nothing in the tool, the engine, or the system prompt prevents it. The system prompt (`lib/appointment-engine.js:306`) says "Help the customer book, change, or cancel an appointment", which is prompt-level guidance, not enforcement.

`update_appointment` has the identical defect and is worse. Same allowlist (`lib/appointment-engine.js:43`), same `workspace_id`-only lookup (`lib/tools/update_appointment.js:34`–`37`), same `workspace_id`-only `UPDATE` (`:89`). But its schema (`lib/tools/update_appointment.js:14`–`25`) exposes `starts_at`, `duration_minutes`, `title`, `notes_internal`, and `quoted_price_cents`. A customer can therefore reschedule a stranger's appointment, rewrite its service title, edit the owner's **internal** notes, and change the quoted price — and the tool obligingly syncs all of it to the linked calendar event (`lib/tools/update_appointment.js:99`–`111`).

Neither tool requires approval (`cancel_appointment.js:24`, `update_appointment.js:29`), and — as noted in 2.1 — the appointment engine ignores `requiresApproval` entirely anyway (`lib/appointment-engine.js:396` calls `execute()` with no diversion equivalent to `server.js:5083`). Setting the flag on these tools would protect the owner path and do nothing for the customer path.

`book_appointment` is scoped correctly by comparison: it derives `contact_id` from the engine-supplied `customer_phone`/`customer_email` rather than trusting a caller-supplied id, and stamps provenance at `lib/tools/book_appointment.js:110`. The contrast makes the omission in the other two look like drift rather than intent — CP6 hardened the *calendar* surface and left the *appointment* surface as it was.

### 4.4 FLAG: owner-only tools that arguably should be customer-reachable

| Tool | Argument for customer reach | Assessment |
|---|---|---|
| `complete_appointment` | None. Marks paid, records `final_price_cents` and `amount_paid_cents`, and auto-drafts a transaction (`lib/tools/complete_appointment.js:20`). A customer must never self-report payment. | **Correctly owner-only.** |
| `find_menu_item` | Real. A customer asking "how much is a gel manicure?" gets answered only from the menu block baked into the system prompt (`lib/appointment-engine.js:248`–`284`), which caps at 200 items (`lib/appointment-engine.js:200`). Past that cap, prices silently disappear from the AI's view with no fallback lookup. | **Defensible gap.** Read-only and workspace-scoped (`lib/tools/find_menu_item.js:13`), so adding it is low-risk. Below the 200-item cap it is redundant. |
| `find_outstanding_balance` | Weak. "What do I owe?" is a fair customer question, but the tool also answers "who has an outstanding balance over $50?" (`lib/tools/find_outstanding_balance.js:20`) — a workspace-wide financial query. It has the same no-ownership-check shape as 4.3. | **Correctly owner-only** as written. Would need a customer-scoped variant, not an allowlist addition. |
| `add_contact` / `update_contact` | A customer correcting their own phone number is reasonable. But `update_contact` identifies contacts by fuzzy **name** (`lib/tools/update_contact.js:9`) with no ownership check, so exposing it would let a customer overwrite anyone's record. | **Correctly owner-only.** |
| `delete_calendar_event` | No. It fuzzy-matches on title and silently deletes the first of up to five matches (`lib/tools/delete_calendar_event.js:37`, `:42`) — the exact class of ambiguity CP6 was written to prevent. | **Correctly owner-only.** |

### 4.5 Secondary boundary observations

1. **`delete_calendar_event` scopes by `user_id`, not `workspace_id`** — `lib/tools/delete_calendar_event.js:26` and `:39`. Every other calendar-touching tool scopes by `workspace_id` (`add_calendar_event.js:108`, `propose_appointment_times.js:64`, `cancel_appointment.js:31`). For a user owning multiple workspaces, a delete issued from workspace A can match and destroy an event in workspace B. Not customer-reachable, so not urgent — but it is an inconsistent tenancy boundary.

2. **`send_broadcast` is the only plan-gated tool** (`lib/tool-registry.js:28`). Its vertical is `property-management` (`lib/tools/send_broadcast.js:29`), yet the Broadcast button renders on `page-contacts` (`views/app.html:2836`) for both verticals. A PS owner on any plan can click Broadcast but cannot ask for it — `getToolsForVertical` (`lib/tool-registry.js:67`) filters it out before the plan check ever runs. This is parity row #50.

3. **The engine's execution loop has no approval concept.** `server.js:5083` diverts `requiresApproval` tools to `pending_actions`; `lib/appointment-engine.js:396` has no counterpart. Today the six allowlisted tools all have `requiresApproval: false`, so nothing is bypassed — but any future allowlist addition of an approval-gated tool would silently execute without review. Worth an explicit guard before the allowlist grows.

4. **Unknown tool names fail differently on each path.** `server.js:5071` returns a structured error to the model; `lib/appointment-engine.js:372` logs and silently `continue`s, so the customer receives whatever prose the model wrote alongside the failed call, with no signal that the action did not happen.

---

## 5. CONTEXT MAP

What "where the owner is standing" means per screen, and where that state actually lives. All line numbers are in `views/app.html`.

**A structural caveat first.** There is no global `currentPage` variable. Both call sites derive it from the DOM:

```
const currentPage = document.querySelector('.page.active')?.id?.replace('page-','') || 'home'
```
— `views/app.html:4361` and `views/app.html:9579`

The second of these is inside `submitHomeCommand()`, which already ships `currentPage` in the `/api/command` body and is read server-side at `server.js:4800`. **A precedent for page-aware context already exists** — the panel should extend it, not invent it.

| Screen | What context sharpens a command | Where the state lives |
|---|---|---|
| `page-home-pm` | "Generate a report on this" → the visible stat window; approval-queue rows are the implicit referents for "approve that" | `_lastAIResponse` `:4279` (assigned `:4287`); queue rows are DOM-only under `#approvalQueueList` (`:2330`) |
| `page-home-ps` | Same, plus "the appointment I'm looking at" from the dashboard list | `loadPSDashboard()` `:8284` renders straight to DOM; **no cached array** |
| `page-inbox` | "Reply to this" = the open message; "archive these" = the current folder | `selectedMessage` `:4189` (assigned `:4592`) — holds the **full object**; `currentFolder` `:4476` (assigned `:4483`); `messages` `:4191` |
| `page-operations` | "Add this to what the AI knows" → knowledge base, not tasks; "turn that off" = automation mode | `_currentAutoReplyState` (set in `submitAutoReplyConsent` `:5055`); knowledge list is DOM-only under `#knowledgeList` (`:2678`) |
| `page-calendar` | **The richest.** "This Friday" must resolve against the visible period, not `new Date()`; "block this off" = the selected day; "reschedule this" = the open event | `calYear`/`calMonth` `:4190`; `calView` `:5188` (assigned `:5288`); `calFocusDate` `:5212` (assigned `:5242`/`:5245`/`:5280`); `selectedDate` `:5293` (assigned `:5355`, `:5793`); `calEvents` `:4194`; **`window._openCalEventData`** — the open event's `{event, appointment, contact}` payload, created implicitly at `:6263`, read at `:6327`/`:6351`/`:6414`; `_workspaceTz` `:6980` (assigned `:8099`) |
| `page-reports` | "Delete this one" = the open report | `_currentReportId` `:7834` (assigned `:7900`, cleared `:7920`) — **id only**, not the object |
| `page-contacts` | "This customer" = the selected contact; "text everyone here" = the active type filter | `selectedContact` `:7407` (assigned `:7456`) — holds the **object**; `contacts` `:7399`; `contactTypeFilter` `:7400` (assigned `:7410`); `_editingContactId` `:7527` |
| `page-inventory` (PM) | "This property" / "this unit" = the open detail pane | `inventoryCurrentEntityId` `:10198` (assigned `:10207`, `:10786`); `inventoryCurrentOfferingId` `:10199` (assigned `:10787`); `inventoryEntities` `:10033`, `inventoryOfferings` `:10034`, `inventoryActiveEngagements` `:10035` |
| `page-tasks` | "Mark these done" = the visible filter set; "this task" = the open modal | `tasks` `:6965`; `taskFilter` `:6966` (assigned `:7128`); **`window._openTaskId`** — implicit at `:6124`, **id only** |
| `page-maintenance` | "This ticket" = the one being edited; "these" = the filtered set | `maintenanceTickets` `:7232`. **No filter variable and no current-ticket variable** — the filter is read from `#maintFilter` (`:3076`, read at `:7248`) and the edited ticket id lives in the hidden `#maintTicketId` input (set at `:7351`) |
| `page-admin` | "Mark this paid" = the visible rent month/year; "this invoice" = the row | Filters are DOM-only: `#rentMonthSel` (`:3299`), `#rentYearSel` (`:3305`). `budgetTransactions` `:6593` |
| `page-finances` | "Refund this" = the open transaction; "these" = the six active filters | `_openTx` `:11691` (assigned `:11959`, cleared `:12102`) — holds the **object**; `_financesVertical` `:11692`. **No transactions array and no filter variables** — all six filters are DOM-only (`#txSearch`, `#txFilterCustomer`, `#txFilterStart`, `#txFilterEnd`, `#txFilterMethod`, `#txFilterStatus`, read at `:11889`–`11894`) |
| `page-my-business` | "Change my tone to warm" → the AI-settings PATCH, not a knowledge row | Form fields only — `#mbTone` (`:3754`), `#mbSalesPosture` (`:3766`), `#mbAutoRespond` (`:3725`), `#mbAutoConfirm` (`:3735`). No JS mirror |
| `page-menu` | "Add an add-on to this" = the open item and the active tab | `_menuTab` `:12227` (assigned `:12732`); `_menuItemsCache` `:12229` (**services only**, for the parent dropdown — not the page list); open item id in hidden `#menuItemId` (`:12787`) |
| `page-inventory-ps` | "Reorder this" = the open item and its preferred vendor | `_invTab` `:12228` (assigned `:12911`); `_vendorsCache` `:12230`; open ids in hidden `#invItemId` (`:12968`) and `#vendorId` (`:13114`). **No page-level arrays** |
| Workspace-wide | Vertical decides vocabulary (customers vs residents); tz decides what "tomorrow" means | `window._workspaceVertical` — implicit at `:8196`, read at `:4228`, `:8271`, `:13436`; `window._planSummary` `:8086` (assigned `:8093`) carries `workspace_vertical` and `workspace_timezone`; `_workspaceTz` `:6980` (assigned `:8099`). **No workspace-id global** — resolved server-side from the session (`server.js:4808`) |

### Two implementation notes for the panel

**Three of the most useful "what's open" values are undeclared implicit globals**, created at first assignment rather than declared: `window._openCalEventData` (`:6263`), `window._openTaskId` (`:6124`), `window._workspaceVertical` (`:8196`). They are `undefined` — not `null` — until the relevant modal or init runs. The panel must null-check rather than assume a declaration-time default.

**Four screens keep their "where am I" entirely in the DOM.** Maintenance (`#maintFilter`, `#maintTicketId`), Finances (six `#txFilter*` inputs), Menu (`#menuItemId`) and PS Inventory (`#invItemId`, `#vendorId`) have no observable JS variable — no assignment to hook, no value to watch. For those the panel must read element values at send time. That is exactly what `submitHomeCommand()` already does at `:9530`–`9592`, reconstructing page context by querying the DOM before posting. Follow that pattern rather than fighting it.

---

## 6. GAP RANKING

Engineering opinion, ranked by how often a real owner would plausibly ask. This is the only section containing recommendations.

| # | Gap | Evidence | Why it ranks here | Cost |
|---|---|---|---|---|
| 1 | **Ownership check on `cancel_appointment` / `update_appointment`** | `lib/tools/cancel_appointment.js:29`–`32`; `lib/tools/update_appointment.js:34`–`37`; allowlist `lib/appointment-engine.js:43`–`44`; identity already in context at `lib/appointment-engine.js:387`–`392` | Not a parity gap — a security gap, and it outranks every feature because the panel ships on top of this surface. The customer engine can mutate any appointment in the workspace by integer id. The fix is the CP6 pattern already in the codebase: compare `ctx.origin.contact_id` against the row's `contact_id` and refuse on mismatch when `ctx.origin.channel === 'ai_inbound'` | **trivial wrapper** — the identity is already in `ctx`; no new query, no migration |
| 2 | **Reading your own data** — no tool answers "what's on my plate?", "who owes me?", "what am I low on?", "show me unpaid rent" | Rows 44, 48, 63, 69, 84, 93–94, 124–126, 131 — **0 of 12 read/filter actions covered**. `find_transaction` (`lib/tools/find_transaction.js:16`), `find_outstanding_balance` and `find_menu_item` are the only read tools among 53 | This is the single highest-frequency owner intent and the panel's most obvious use. Today it works only by accident: the snapshot injected at `server.js:4900`–`4925` covers rent, maintenance, properties and units, and the prompt instructs the AI to answer inventory reads from it without tools (`server.js:4993`). Tasks, contacts, PS inventory and vendors are **not** in the snapshot for PS workspaces — those questions have no answer path at all. The snapshot also degrades: `server.js:4928`–`4930` already flags that >200 units drowns it | **trivial wrapper** for `find_task`, `find_contact`, `find_inventory_item`, `find_vendor` — all are `SELECT`s over existing tables with existing endpoints (`GET /api/tasks`, `/api/contacts`, `/api/inventory-items`, `/api/vendors`) |
| 3 | **Deleting anything** | Rows 38, 53, 68, 74, 89, 92, 96, 129, 134 — **0 of 9 delete actions covered**. Only `delete_calendar_event` exists, and it is title-fuzzy (`lib/tools/delete_calendar_event.js:15`) | "Delete that task" is among the most natural things to say to a panel and currently fails silently — the model has no tool, so it either apologizes or hallucinates success. `update_task` (`lib/tools/update_task.js:10`) can mark done but not remove | **trivial wrapper** — `DELETE /api/tasks/:id`, `/api/contacts/:id`, `/api/rent/:id`, `/api/invoices/:id`, `/api/budget/:id` all exist and are already called from the UI (`views/app.html:7123`, `8025`, `6688`, `6782`, `6909`) |
| 4 | **Settings by voice** — 0 of 17 config actions covered | Rows 23–30, 75–78, 109, 114–118. `PATCH /api/workspace/ai-settings` (`views/app.html:12629`), `PUT /api/settings` (`views/app.html:4845`), `POST /api/knowledge` (`views/app.html:5154`) all have no tool | "Stop auto-booking", "be more formal", "we close at 6 now" are things owners say constantly, and the last one is worst: business hours exist **only** as a free-text knowledge row (`views/app.html:3617`), which the engine reads verbatim into the prompt (`lib/appointment-engine.js:238`–`246`). An owner can change hours by clicking but not by asking, while the AI books against those hours all day | **trivial wrapper** for `update_ai_settings` and `update_knowledge` — endpoints exist. Note the flip side: a settings tool lets the AI change its own guardrails, so `requiresApproval: true` (`lib/tool-registry.js:52`) is the right default here |
| 5 | **`delete_calendar_event` can't target an id** | `lib/tools/delete_calendar_event.js:15` requires `event` (title); `:37` takes `matches.rows[0]`; `:42` admits it "matched N events; deleted the first". UI deletes by id (`views/app.html:6519`) | Parity rows 36/36b. With the panel open on the calendar and `window._openCalEventData` (`:6263`) right there, "delete this" is the most natural possible phrasing — and it currently routes through fuzzy title matching that can delete the wrong event. Time-off blocks share titles constantly | **trivial wrapper** — add an optional `event_id` to the schema and prefer it when present; no endpoint or schema work |
| 6 | **No refund tool** | Row 105. `void_transaction` explicitly refuses paid transactions (`lib/tools/void_transaction.js:13`); the UI has `POST /api/transactions/:id/refund` (`views/app.html:12166`) | Refunds are low-frequency but high-salience — when an owner needs one they need it now, usually with the customer standing there. The endpoint exists and the modal already collects amount + reason (`views/app.html:4132`, `4136`) | **trivial wrapper** — endpoint exists. Should be `requiresApproval: true` to match the money-movement precedent set by `request_payments_batch` (`lib/tools/request_payments_batch.js:44`) |
| 7 | **Multi-day time-off is N tool calls** | Row 35. `lib/tools/add_calendar_event.js:35` says "call this tool once per day"; the agentic loop caps at `MAX_ITERATIONS = 5` (`server.js:5021`); the UI expands ranges server-side up to 31 days (`views/app.html:6035`) | "I'm on vacation next week" is a routine ask that silently half-completes today — 5 iterations cannot cover 7 days, and the owner gets a partial block with no warning. The UI already solved this; the tool did not | **needs new endpoint** — or a `end_date` parameter on the tool plus a server-side loop mirroring `submitBlockOff` (`views/app.html:5995`). The refusal guard at `lib/tools/add_calendar_event.js:76` must be preserved through the change |
| 8 | **No approval of pending actions** | Rows 7–9. `POST /api/pending-actions/:id/approve` (`views/app.html:9178`) has no tool wrapper | With a persistent panel, "yes, send it" is the obvious reply to an approval chip. Ranked below the above because the chip's Approve button will be visibly adjacent in the panel — a click is right there. Worth noting the recursion risk: a tool that approves queued tools lets the AI clear its own approval gate, which would defeat the `server.js:5083` diversion entirely | **trivial wrapper**, but should be **deliberately excluded** from the tool list rather than built. Flagged for completeness, not recommended |
| 9 | **Owner cannot book an appointment by clicking** | Section 3.2. `+ Add Event` (`views/app.html:2735`) writes `cal_events` only; `book_appointment` (`lib/tools/book_appointment.js:114`) writes `appointments` + `cal_events` + thread linkage | The inverse gap: the tool is ahead of the UI. Phone-in bookings — a salon's daily reality — must go through the command bar or the AI. Under the governing principle this is fine (asking works), but it means the panel is load-bearing for a core workflow, not merely convenient | **no work required for parity** — noted as an argument for the panel, not against it |
| 10 | **`complete_appointment` has no UI control** | Section 3.2; verified absent across `renderCalEventDetail` `views/app.html:6254`–`6325` | Same inverse shape as #9. Closing out an appointment with a final price is the end of every service transaction, and today it is ask-only. Worth knowing the panel carries it | **no work required for parity** |
| 11 | **`send_broadcast` unreachable for PS owners** | Row 50. `vertical:'property-management'` at `lib/tools/send_broadcast.js:29`; filtered by `lib/tool-registry.js:67`; button renders for both verticals at `views/app.html:2836` | Low frequency but a clean inconsistency: the button is visible and works, the ask silently is not offered. A salon owner texting all clients about a closure is a legitimate PS use case | **trivial wrapper** — change `vertical` to `'core'`, or register a PS variant. The plan gate (`lib/tool-registry.js:28`) already handles tier enforcement independently of vertical |
| 12 | **Archive tools missing for PS inventory and vendors** | Rows 129, 134. `POST /api/inventory-items/:id/archive` (`views/app.html:13061`) and `POST /api/vendors/:id/archive` (`views/app.html:13176`) have no tool wrappers, while `archive_menu_item` (`lib/tools/archive_menu_item.js:11`) covers the menu | Low frequency — inventory and vendor lists churn slowly. Listed for completeness of the delete cluster | **trivial wrapper** — both endpoints exist |

**Cost distribution:** 9 trivial wrappers, 1 needs-new-endpoint, 0 needs-schema, 2 no-work-required. Nothing in this audit requires a migration. The parity gap is overwhelmingly a matter of tools not yet written over endpoints that already exist — with the notable exception of item #1, which is not a parity gap at all and should be fixed before the panel ships.
