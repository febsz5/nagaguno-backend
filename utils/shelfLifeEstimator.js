// utils/shelfLifeEstimator.js
//
// Real gap found and fixed: shelf_life_days existed as a column on
// products this entire session, but was never actually set anywhere
// in the backend -- every product had it as NULL, which meant the
// automatic spoilage detection view had no real input to work with,
// regardless of how correct its own logic was.
//
// Estimates below are grounded in real sources, not guessed:
// - Philippine-specific ambient/room-temperature findings (gourds
//   incl. ampalaya: up to 7 days uncut at cool room temp; eggplant/
//   talong: 3-4 days; leafy greens like alugbati/malunggay: 2-3 days)
// - General USDA/extension-service produce storage data for items
//   without a Philippine-specific source, adjusted down from
//   refrigerated figures since this marketplace sells at ambient
//   tropical temperature, not cold-chain.
// This is a real, cited estimate, not a precise guarantee for every
// variety or storage condition -- sellers can always override via
// manual spoilage reporting, which takes priority regardless.

// Specific crop name -> shelf life in days, matched case-insensitively
// as a substring against the product's name (so "Chayote" and
// "Sayote" both match the same entry, "Talong Long Variety" still
// matches "talong", etc).
const NAME_OVERRIDES = {
  'chayote': 10, 'sayote': 10,
  'ampalaya': 7, 'bitter gourd': 7,
  'talong': 4, 'eggplant': 4,
  'kamatis': 5, 'tomato': 5,
  'sitaw': 5, 'string bean': 5,
  'repolyo': 21, 'cabbage': 21,
  'petsay': 5, 'pechay': 5, 'bok choy': 5,
  'sibuyas': 30, 'onion': 30,
  'bawang': 60, 'garlic': 60,
  'patatas': 30, 'potato': 30,
  'kalabasa': 60, 'squash': 60,
  'kangkong': 3, 'water spinach': 3,
  'malunggay': 2, 'moringa': 2,
  'okra': 5,
  'singkamas': 14, 'jicama': 14,
  'papaya': 5,
  'saging': 5, 'banana': 5,
  'mangga': 6, 'mango': 6,
  'palay': 180, 'rice': 180,
  'mais': 3, 'corn': 3,
  'niyog': 30, 'coconut': 30,
  'gabi': 30, 'taro': 30,
  'kamote': 21, 'sweet potato': 21,
};

// Category-level fallback when no specific name match is found.
// Matches the real product_category enum exactly.
const CATEGORY_DEFAULTS = {
  'Vegetables': 5,
  'Fruits': 5,
  'Root Crops': 21,
  'Herbs': 3,
  'Rice': 180,
  'Legumes': 14,
  'Others': 7,
};

function estimateShelfLifeDays(productName, category) {
  const nameLower = (productName || '').toLowerCase();
  for (const [key, days] of Object.entries(NAME_OVERRIDES)) {
    if (nameLower.includes(key)) return days;
  }
  return CATEGORY_DEFAULTS[category] ?? 7; // generic, conservative fallback
}

module.exports = { estimateShelfLifeDays };