// lib/tools/generate_report.js
//
// Generates a written report and saves it to the reports table.
// The actual content generation is delegated to ctx.generateReportContent
// (the same helper POST /api/reports uses) so there's exactly one source
// of truth for "how to generate a report" — both manual and AI paths.
//
// reports schema: (workspace_id, user_id, title, type, prompt, content,
//   data_snapshot JSONB, parameters JSONB, created_at, updated_at).
// workspace_id-scoped. user_id is set to the requesting user; nullable
// in schema so reports survive a user removal.
const registry = require('../tool-registry');

registry.register({
  name: 'generate_report',
  description: 'Generate a written report and save it. The user describes what they want in natural language. Common report types include budget reports (income, expenses, trends, suggestions), tenant reports (rent status, lease expirations, communication summaries), inventory reports (occupancy, vacancy, maintenance), activity reports (recent events, messages, tasks), and general reports (overall property snapshot). Use this tool whenever the user asks to "generate", "create", "make", "produce", "write", or "give me" a report. The report is saved to the Reports page where the user can view it.',
  vertical: 'core',
  category: 'create',
  schema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: "Natural-language description of the report the user wants. Pass through the user's phrasing.",
      },
      report_type: {
        type: 'string',
        enum: ['budget', 'tenant', 'inventory', 'activity', 'general'],
        description: 'Optional. The category of report. Infer from the description if not obvious. Use "general" when in doubt.',
      },
      title: {
        type: 'string',
        description: 'Optional. Title for the report. If omitted, one is generated from the description.',
      },
      date_range: {
        type: 'string',
        description: 'Optional. Date range hint like "last 30 days", "Q1 2026", "March 2026", "year to date". Stored as a parameter; the AI generation uses it as guidance.',
      },
    },
    required: ['description'],
  },
  navigationPolicy: 'auto',
  navigateTo: { page: 'reports', focus: { type: 'specific_report', reportId: '$id' } },
  async execute(input, ctx) {
    const { description, report_type, title, date_range } = input;
    if (!description) {
      return { success: false, message: 'Missing required field: description.' };
    }
    if (typeof ctx.generateReportContent !== 'function') {
      return { success: false, message: 'Report generation helper is unavailable in this request context.' };
    }
    const type = report_type || 'general';

    try {
      const generated = await ctx.generateReportContent({
        workspaceId: ctx.workspace.id,
        type,
        prompt: description,
        parameters: date_range ? { date_range } : null,
      });

      const result = await ctx.db.query(
        `INSERT INTO reports (workspace_id, user_id, title, type, prompt, content, data_snapshot, parameters)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, title, type`,
        [
          ctx.workspace.id,
          ctx.user.id,
          title || generated.title,
          type,
          description,
          generated.content,
          JSON.stringify(generated.data_snapshot),
          date_range ? JSON.stringify({ date_range }) : null,
        ]
      );

      const saved = result.rows[0];
      return {
        success: true,
        data: saved,
        message: `Generated ${type} report: ${saved.title}. View it on the Reports page.`,
      };
    } catch (err) {
      ctx.logger.error('[generate_report] failed:', err);
      return {
        success: false,
        message: `Failed to generate report: ${err.message}`,
      };
    }
  },
});
