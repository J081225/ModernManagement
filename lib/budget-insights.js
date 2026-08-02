// lib/budget-insights.js — BG7. The CP7 reflection engine pointed at
// money: a no-tools model call over the LIVE LEDGER CONTEXT instead of
// a conversation transcript. Same rails as lib/reflection.js — cap
// check BEFORE the call, dismissal dedupe, strict JSON, hard field
// caps, suggested-task delivery — and the same law: rails propose
// nothing; the brain proposes, never executes.
//
// CADENCE (BG7 look-first b): the daily-nudge ensure trigger — the
// pass fires once per workspace-day, on the FIRST app open, riding
// the nudge's existing cal_events idempotency. Why: insights are for
// the owner who is looking (dormant workspaces spend nothing), daily
// is periodic-not-reactive (never per money event), and the gate
// already exists — no new timers, no new tables.
//
// TEST MONEY cannot generate false insights STRUCTURALLY: the context
// is the BG1 summary, whose money_in already excludes demo dollars in
// test mode — a workspace with only test payments shows real revenue
// of $0, so "great revenue!" is impossible to derive from the fields;
// demo money arrives only in the separately-labeled demo_cents field
// and the prompt says what it is.

const { isDismissedDuplicate, validateExpensePayload, MAX_UNRESOLVED_SUGGESTIONS } = require('./reflection');
const { computeFinancesSummary } = require('./finances-summary');

const MAX_INSIGHTS_PER_RUN = 2;
const TITLE_CAP = 120;
const REASON_CAP = 300;

// Previous calendar month as a custom range, from the workspace-local
// today (YYYY-MM-DD).
function prevMonthRange(todayLocal) {
  const [y, m] = String(todayLocal).split('-').map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const start = `${py}-${String(pm).padStart(2, '0')}-01`;
  const end = `${y}-${String(m).padStart(2, '0')}-01`;
  return { start, end };
}

async function runBudgetInsightPass({ db, anthropic, model, workspace, env, logger, wsToday }) {
  const log = logger || console;
  try {
    const owner = workspace.owner_user_id;

    // Cap BEFORE the call — never queue-jump, never spend the tokens.
    const cR = await db.query(
      `SELECT COUNT(*)::int AS n FROM tasks
        WHERE user_id = $1 AND suggested = true AND done = false AND dismissed_at IS NULL`,
      [owner]
    );
    if ((cR.rows[0] ? cR.rows[0].n : 0) >= MAX_UNRESOLVED_SUGGESTIONS) {
      return { ran: false, reason: 'cap_reached' };
    }

    // Dismissal memory — a dismissed insight does not return tomorrow.
    let dismissedTitles = [];
    try {
      const dR = await db.query(
        `SELECT title FROM tasks
          WHERE user_id = $1 AND dismissed_at IS NOT NULL
            AND dismissed_at > NOW() - INTERVAL '30 days'`,
        [owner]
      );
      dismissedTitles = dR.rows.map((r) => r.title);
    } catch (err) {
      log.error('[budget-insights] dismissal fetch failed (deduping nothing):', err.message);
    }

    // The ledger context: this month + last month, from the derived
    // summary (both feeds, demo split, goal progress, cash, anchor).
    // ONE clock for the whole pass: wsToday is the pass's injected
    // time source — the summary period and days-left math derive from
    // it too (they previously leaked to the wall clock, which made the
    // pass non-deterministic under a pinned fixture clock and skewed
    // vs the ws-timezone date near month boundaries). Noon UTC keeps
    // the day arithmetic stable across timezone offsets.
    const today = wsToday(workspace);
    const nowRef = today + 'T12:00:00.000Z';
    const thisMonth = await computeFinancesSummary({ db, workspace, period: 'month', env, now: nowRef });
    const prev = prevMonthRange(today);
    const lastMonth = await computeFinancesSummary({ db, workspace, period: 'custom', start: prev.start, end: prev.end, env });

    const daysLeft = (() => {
      try {
        const end = new Date(thisMonth.period.end).getTime();
        return Math.max(0, Math.ceil((end - new Date(nowRef).getTime()) / 86400000));
      } catch (err) { return null; }
    })();

    const context = {
      today,
      live_mode: thisMonth.live_mode,
      cash_current_cents: thisMonth.cash_current_cents,
      anchor_as_of: thisMonth.anchor ? thisMonth.anchor.as_of : null,
      goal: thisMonth.goal ? {
        label: thisMonth.goal.label, target_cents: thisMonth.goal.target_cents,
        progress_cents: thisMonth.goal.progress_cents, period: thisMonth.goal.period,
        days_left_in_period: daysLeft,
      } : null,
      this_month: {
        money_in_cents: thisMonth.money_in.combined_cents,
        deposits_cents: thisMonth.money_in.deposits_cents,
        money_out_cents: thisMonth.money_out.combined_cents,
        net_cents: thisMonth.net_cents,
        by_category: thisMonth.by_category,
      },
      last_month: {
        money_in_cents: lastMonth.money_in.combined_cents,
        money_out_cents: lastMonth.money_out.combined_cents,
        by_category: lastMonth.by_category,
      },
      demo_cents_this_month: thisMonth.money_in_demo_cents,
    };

    // One call. NO TOOLS. Zero is the expected answer for a healthy month.
    const response = await anthropic.messages.create({
      model,
      max_tokens: 400,
      system: 'You review a small business\'s budget snapshot for the owner. Emit an insight ONLY when a NUMBER in the data genuinely deserves attention: goal pace (ahead/behind with days left), a category spending spike this month vs last, low cash on hand, a stale cash count (anchor_as_of long ago), or a large outflow. A HEALTHY MONTH NEEDS NO INSIGHTS — return [] for it; the empty array is the expected, correct answer most of the time, and an owner nagged with noise stops reading. Every reason must cite the actual numbers from the data (e.g. "you\'re at $6,200 of your $8,000 goal with 6 days left"). If a number is not confidently derivable from the data, say NOTHING about it — never invent a trend. demo_cents_this_month is TEST-MODE play money: never praise or count it as revenue; real money_in already excludes it. Return ONLY a JSON array, 0 to '
        + MAX_INSIGHTS_PER_RUN
        + ' items: {"title": string (short), "reason": string (ONE line citing the numbers), "expense": (ONLY for a clearly-missing expense the data itself implies — rare) {"amount_cents": integer or null, "category": Supplies|Payroll|Rent|Utilities|Marketing|Fees|Other or null, "vendor": string or null}}.',
      messages: [{ role: 'user', content: 'Budget snapshot (all amounts integer cents):\n' + JSON.stringify(context) }],
    });

    let insights = [];
    try {
      const text = ((response.content && response.content[0] && response.content[0].text) || '').trim();
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('no JSON array in output');
      const parsed = JSON.parse(match[0]);
      if (!Array.isArray(parsed)) throw new Error('output not an array');
      insights = parsed;
    } catch (err) {
      log.error('[budget-insights] malformed output dropped:', err.message);
      return { ran: true, inserted: 0, reason: 'malformed_output' };
    }

    let inserted = 0;
    for (const s of insights.slice(0, MAX_INSIGHTS_PER_RUN)) {
      let title = (s && typeof s.title === 'string') ? s.title.trim().slice(0, TITLE_CAP) : '';
      const reason = (s && typeof s.reason === 'string') ? s.reason.trim().slice(0, REASON_CAP) : '';
      if (!title || !reason) continue;
      if (isDismissedDuplicate(title, dismissedTitles)) {
        log.log('[budget-insights] deduped against a recent dismissal: ' + title);
        continue;
      }
      // Optional expense payload — the BG5 marker, same validation.
      let marker = null;
      if (s && s.expense && typeof s.expense === 'object') {
        const ex = validateExpensePayload(s.expense);
        marker = JSON.stringify(ex);
        if (!title.toLowerCase().startsWith('post ')) {
          title = (ex.amount_cents != null && ex.category)
            ? ('Post $' + (ex.amount_cents / 100).toFixed(2) + ' to ' + ex.category + '?').slice(0, TITLE_CAP)
            : ('Post an expense? ' + title).slice(0, TITLE_CAP);
        }
      }
      const notes = 'Budget insight (from your live ledger).' + (marker ? '\nEXPENSE ' + marker : '');
      try {
        await db.query(
          `INSERT INTO tasks (user_id, title, category, "dueDate", notes, done, suggested, "aiReason")
           VALUES ($1, $2, 'budget_insight', $3, $4, false, true, $5)`,
          [owner, title, today, notes, reason]
        );
        inserted++;
      } catch (err) {
        log.error('[budget-insights] insert failed:', err.message);
      }
    }
    if (inserted) log.log('[budget-insights] workspace=' + workspace.id + ' -> ' + inserted + ' insight(s)');
    return { ran: true, inserted };
  } catch (err) {
    log.error('[budget-insights] pass failed (nothing affected):', err.message);
    return { ran: false, reason: 'error', error: err.message };
  }
}

module.exports = { runBudgetInsightPass, prevMonthRange, MAX_INSIGHTS_PER_RUN };
