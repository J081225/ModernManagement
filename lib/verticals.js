// lib/verticals.js
//
// Central config for Modern Management's verticals.
//
// Hyphen-form slugs are canonical. Database column workspaces.vertical
// (added by migration 026, constrained by migration 033) stores values
// from this list.
//
// To add a new vertical:
//   1. Add an entry to VERTICALS below
//   2. Write a migration that ALTERs workspaces_vertical_check to allow
//      the new slug
//   3. Tag any vertical-specific tools in lib/tools/ with the new slug
//   4. Add UI/landing page for it in subsequent sessions

const VERTICALS = {
  'property-management': {
    slug: 'property-management',
    displayName: 'Property Management',
    shortName: 'PM',
    tagline: 'AI for property managers and landlords',
    description: 'Manage tenants, rent, maintenance, and broadcasts from one AI-powered workspace.',
    available: true,
    landingPage: '/property-management',
    sectionLabels: {
      contacts: 'Tenants',
      properties: 'Properties',
      units: 'Units',
      maintenance: 'Maintenance',
      payments: 'Rent Payments',
      inventory: 'Properties',
    },
  },
  'professional-services': {
    slug: 'professional-services',
    displayName: 'Professional Services',
    shortName: 'PS',
    tagline: 'AI for service business owners',
    description: 'Run appointments, service receipts, and customer communications from one AI-powered workspace.',
    available: true,
    landingPage: '/professional-services',
    sectionLabels: {
      contacts: 'Customers',
      properties: null,
      units: null,
      maintenance: 'Appointments',
      payments: 'Service Receipts',
      inventory: 'Products & Services',
    },
  },
};

const DEFAULT_VERTICAL = 'property-management';

function getVertical(slug) {
  return VERTICALS[slug] || null;
}

function listAvailableVerticals() {
  return Object.values(VERTICALS).filter((v) => v.available);
}

function validateVertical(slug) {
  if (slug && Object.prototype.hasOwnProperty.call(VERTICALS, slug)) {
    return slug;
  }
  return DEFAULT_VERTICAL;
}

// Convert legacy underscore form (e.g. 'property_management') to canonical
// hyphen form. Kept for safety even though no underscore-form column
// exists in the current schema — if we ever need to ingest a legacy
// slug from external metadata, this handles it without a special case.
function canonicalizeLegacyVertical(legacySlug) {
  if (!legacySlug) return DEFAULT_VERTICAL;
  const candidate = String(legacySlug).replace(/_/g, '-');
  return validateVertical(candidate);
}

module.exports = {
  VERTICALS,
  DEFAULT_VERTICAL,
  getVertical,
  listAvailableVerticals,
  validateVertical,
  canonicalizeLegacyVertical,
};
