// lib/tools/find_menu_item.js
//
// Natural-language menu lookup. Used by the AI command bar and (indirectly)
// the appointment engine. Filters by type/category if provided; fuzzy-matches
// name + description. Returns up to 10 results.

const registry = require('../tool-registry');

registry.register({
  name: 'find_menu_item',
  description: 'Search the workspace menu by free-text query, optionally filtered by type (service / product / addon) or category. Returns up to 10 matching items as summaries (id, name, type, category, base_price_cents, duration_minutes, description, active).',
  vertical: 'professional-services',
  category: 'read',
  schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      type: { type: 'string', enum: ['service', 'product', 'addon'] },
      category: { type: 'string' },
    },
    required: ['query'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const q = String(input.query || '').trim();
    if (!q) return { success: false, message: 'query is required.' };

    const where = ['workspace_id = $1', 'archived_at IS NULL'];
    const params = [ctx.workspace.id];
    let i = 2;
    if (input.type && ['service', 'product', 'addon'].includes(input.type)) {
      where.push(`type = $${i++}`);
      params.push(input.type);
    }
    if (input.category) {
      where.push(`LOWER(category) = $${i++}`);
      params.push(String(input.category).toLowerCase());
    }
    where.push(`(LOWER(name) LIKE $${i} OR LOWER(COALESCE(description, '')) LIKE $${i})`);
    params.push('%' + q.toLowerCase() + '%');

    try {
      const r = await ctx.db.query(
        `SELECT id, name, type, category, base_price_cents, duration_minutes,
                description, active, parent_menu_item_id, tax_behavior
           FROM menu_items
          WHERE ${where.join(' AND ')}
          ORDER BY active DESC, type ASC, name ASC
          LIMIT 10`,
        params
      );
      const rows = r.rows;
      if (rows.length === 0) {
        return { success: true, data: { menu_items: [] }, message: `No menu items matching "${q}".` };
      }
      const summary = rows.slice(0, 5).map(it => {
        const price = it.base_price_cents > 0 ? `$${(it.base_price_cents / 100).toFixed(2)}` : '—';
        const dur = it.duration_minutes ? `${it.duration_minutes} min` : '';
        const tag = `${it.type}${dur ? ', ' + dur : ''}`;
        return `#${it.id} ${it.name} (${tag}) ${price}`;
      }).join('; ');
      const more = rows.length > 5 ? ` (+${rows.length - 5} more)` : '';
      return {
        success: true,
        data: { menu_items: rows },
        message: `Found ${rows.length} menu item${rows.length === 1 ? '' : 's'}: ${summary}${more}`,
      };
    } catch (err) {
      ctx.logger.error('[find_menu_item] query failed:', err.message);
      return { success: false, message: `Could not search menu: ${err.message}` };
    }
  },
});
