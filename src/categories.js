// Etsy listing categories for this shop.
//
// EDIT THIS LIST so each `path` matches Etsy's own category picker EXACTLY
// (Shop Manager > Listings > [listing] > Category). The model uses `path` to
// angle each variant at that category's buyer — it does not set the actual
// Etsy category for you, so the real category you choose at listing time on
// Etsy must match what you picked here.
//
// - id: stable key used internally (results tabs, request/response data).
//   Keep it short, lowercase, no spaces. Don't reuse an id for a different
//   category later — that would misattribute past results if ever cached.
// - label: short text shown on the checkbox and the results tab.
// - path: the full Etsy breadcrumb, "Top Level > Sub > Sub".
export const CATEGORIES = [
  {
    id: 'balloons',
    label: 'Balloons',
    path: 'Paper & Party Supplies > Party Décor > Balloons',
  },
  {
    id: 'cookies',
    label: 'Cookies',
    path: 'Food & Drink > Baked Goods > Cookies',
  },
  {
    id: 'cakes',
    label: 'Cakes',
    path: 'Food & Drink > Baked Goods > Cakes',
  },
  {
    id: 'cupcakes',
    label: 'Cupcakes',
    path: 'Food & Drink > Baked Goods > Cupcakes',
  },
  {
    id: 'pastries',
    label: 'Pastries',
    path: 'Food & Drink > Baked Goods > Pastries',
  },
]
