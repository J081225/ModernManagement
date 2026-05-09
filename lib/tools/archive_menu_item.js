// lib/tools/archive_menu_item.js
//
// Soft-archive a menu item (sets archived_at = NOW() and active = FALSE).
// The row stays in the database — past appointments and transactions still
// reference it. Cascade-archives any add-ons of an archived service so
// orphaned add-ons don't pollute the menu.

const registry = require('../tool-registry');

registry.register({
  name: 'archive_menu_item',
  description: 'Archive (soft-delete) a menu item. Past records still reference it. If archiving a service, its add-ons are also archived. To bring it back, edit it in the UI.',
  vertical: 'professional-services',
  category: 'delete',
  schema: {
    type: 'object',
    properties: {
      menu_item_id: { type: 'integer' },
    },
    required: ['menu_item_id'],
  },
  navigationPolicy: 'never',
  navigateTo: null,
  requiresApproval: false,
  async execute(input, ctx) {
    const id = parseInt(input.menu_item_id, 10);
    if (!id) return { success: false, message: 'menu_item_id is required.' };

    const found = await ctx.db.query(
      `SELECT id, type, name, archived_at FROM menu_items WHERE id = $1 AND workspace_id = $2`,
      [id, ctx.workspace.id]
    );
    if (found.rows.length === 0) {
      return { success: false, message: `No menu item with id ${id} in this workspace.` };
    }
    const item = found.rows[0];
    if (item.archived_at) {
      return { success: false, message: `${item.name} is already archived.` };
    }

    try {
      await ctx.db.query(
        `UPDATE menu_items
            SET archived_at = NOW(), active = FALSE, updated_at = NOW()
          WHERE id = $1 AND workspace_id = $2`,
        [id, ctx.workspace.id]
      );

      // Cascade-archive add-ons if this is a service
      let cascadeCount = 0;
      if (item.type === 'service') {
        const r = await ctx.db.query(
          `UPDATE menu_items
              SET archived_at = NOW(), active = FALSE, updated_at = NOW()
            WHERE parent_menu_item_id = $1
              AND workspace_id = $2
              AND archived_at IS NULL
            RETURNING id`,
          [id, ctx.workspace.id]
        );
        cascadeCount = r.rows.length;
      }

      return {
        success: true,
        data: { menu_item_id: id, name: item.name, archived_addons: cascadeCount },
        message: cascadeCount > 0
          ? `Archived ${item.name} and ${cascadeCount} add-on${cascadeCount === 1 ? '' : 's'}.`
          : `Archived ${item.name}.`,
      };
    } catch (err) {
      ctx.logger.error('[archive_menu_item] failed:', err.message);
      return { success: false, message: `Could not archive: ${err.message}` };
    }
  },
});
