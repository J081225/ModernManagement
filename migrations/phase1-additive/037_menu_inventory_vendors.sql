-- E4: Menu items, inventory items, vendors. Plus inventory_tracking_enabled
-- on workspaces.
--
-- menu_items holds services, products, AND add-ons in one table. UI shows
-- them as separate tabs via the type column.
-- inventory_items is opt-in per workspace via inventory_tracking_enabled.
-- vendors are workspace-scoped suppliers.

-- Workspace setting
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS inventory_tracking_enabled BOOLEAN DEFAULT FALSE;

-- Vendors first (no FK dependencies)
CREATE TABLE IF NOT EXISTS vendors (
  id                       SERIAL PRIMARY KEY,
  workspace_id             INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  contact_phone            TEXT,
  contact_email            TEXT,
  contact_url              TEXT,
  notes                    TEXT,
  archived_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendors_workspace ON vendors(workspace_id) WHERE archived_at IS NULL;

-- Inventory items (depends on vendors)
CREATE TABLE IF NOT EXISTS inventory_items (
  id                       SERIAL PRIMARY KEY,
  workspace_id             INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  category                 TEXT,
  status                   TEXT NOT NULL DEFAULT 'in_stock',
  quantity                 NUMERIC,
  unit                     TEXT, -- 'bottle', 'box', 'each', etc.
  preferred_vendor_id      INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  notes                    TEXT,
  last_restocked_at        TIMESTAMPTZ,
  last_used_at             TIMESTAMPTZ,
  archived_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                  WHERE constraint_name='inventory_items_status_check' AND table_name='inventory_items') THEN
    ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_status_check
      CHECK (status IN ('in_stock','low','out'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_items_workspace_status ON inventory_items(workspace_id, status) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_items_preferred_vendor ON inventory_items(preferred_vendor_id) WHERE preferred_vendor_id IS NOT NULL;

-- Menu items (depends on inventory_items for products that link to inventory; self-referential for add-ons)
CREATE TABLE IF NOT EXISTS menu_items (
  id                       SERIAL PRIMARY KEY,
  workspace_id             INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type                     TEXT NOT NULL,
  name                     TEXT NOT NULL,
  description              TEXT,
  category                 TEXT, -- 'Nails', 'Hair', 'Add-ons', etc.
  base_price_cents         INTEGER NOT NULL DEFAULT 0,
  duration_minutes         INTEGER, -- services only; null for products and add-ons-without-time
  tax_behavior             TEXT NOT NULL DEFAULT 'none',
  parent_menu_item_id      INTEGER REFERENCES menu_items(id) ON DELETE CASCADE, -- for add-ons
  inventory_item_id        INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL, -- for products
  active                   BOOLEAN NOT NULL DEFAULT TRUE,
  archived_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                  WHERE constraint_name='menu_items_type_check' AND table_name='menu_items') THEN
    ALTER TABLE menu_items ADD CONSTRAINT menu_items_type_check
      CHECK (type IN ('service','product','addon'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                  WHERE constraint_name='menu_items_tax_behavior_check' AND table_name='menu_items') THEN
    ALTER TABLE menu_items ADD CONSTRAINT menu_items_tax_behavior_check
      CHECK (tax_behavior IN ('included','added','none'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                  WHERE constraint_name='menu_items_addon_parent_check' AND table_name='menu_items') THEN
    -- An add-on must have a parent_menu_item_id; non-addons must not
    ALTER TABLE menu_items ADD CONSTRAINT menu_items_addon_parent_check
      CHECK ((type = 'addon' AND parent_menu_item_id IS NOT NULL)
          OR (type IN ('service','product') AND parent_menu_item_id IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_menu_items_workspace_type ON menu_items(workspace_id, type) WHERE archived_at IS NULL AND active = TRUE;
CREATE INDEX IF NOT EXISTS idx_menu_items_workspace_category ON menu_items(workspace_id, category) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_menu_items_parent ON menu_items(parent_menu_item_id) WHERE parent_menu_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_menu_items_inventory ON menu_items(inventory_item_id) WHERE inventory_item_id IS NOT NULL;
