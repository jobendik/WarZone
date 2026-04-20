/**
 * Glyphs — central SVG icon registry.
 *
 * Single source of truth for all vector icons used by the HUD, medals,
 * mode cards, and weapon card.  Keeps rendering crisp at any size,
 * unlike emoji which vary wildly across platforms.
 */

export const GLYPHS = {
  // ── Vitals ──────────────────────────────────────────────────────────
  heart: `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 14s-5-3.5-5-8a3 3 0 0 1 5-2.23A3 3 0 0 1 13 6c0 4.5-5 8-5 8z"/></svg>`,
  shield: `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 1 2 3v5c0 3.5 2.6 6.5 6 7 3.4-.5 6-3.5 6-7V3L8 1z"/></svg>`,
  grenade: `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="10" r="5"/><rect x="6" y="2" width="4" height="3"/><path d="M5 5h6v1H5z"/></svg>`,

  // ── Medals ──────────────────────────────────────────────────────────
  medal_star: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><polygon points="12,2 15.09,9 22,10.27 17,15.14 18.18,22 12,18.77 5.82,22 7,15.14 2,10.27 8.91,9"/></svg>`,
  medal_diamond: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><polygon points="12,2 22,12 12,22 2,12"/></svg>`,
  medal_shield: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L4 6v6c0 5.5 3.8 10.7 8 12 4.2-1.3 8-6.5 8-12V6L12 2z"/></svg>`,
  medal_crosshair: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" stroke-width="2" fill="none"/></svg>`,
  medal_blade: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M4 20L20 4l-2 8-8 2z"/><circle cx="4" cy="20" r="2"/></svg>`,
  medal_x: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="square"/></svg>`,
  medal_rocket: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C8 7 7 11 8 14l-3 3 1 2 2 1 3-3c3 1 7 0 12-4L12 2z"/></svg>`,
  medal_explosion: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="square"/></svg>`,
  medal_double: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="700" font-family="monospace">2×</text></svg>`,
  medal_triple: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="700" font-family="monospace">3×</text></svg>`,
  medal_quad: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="700" font-family="monospace">4×</text></svg>`,
  medal_drop: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C8 8 6 11 6 14a6 6 0 0 0 12 0c0-3-2-6-6-12z"/></svg>`,
  medal_scope: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="7" stroke="currentColor" stroke-width="2"/><line x1="12" y1="17" x2="12" y2="22" stroke="currentColor" stroke-width="2"/><line x1="2" y1="12" x2="7" y2="12" stroke="currentColor" stroke-width="2"/><line x1="17" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="2"/></svg>`,
  medal_circle_dot: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="3"/></svg>`,
  medal_double_circle: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="12" r="5" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="16" cy="12" r="5" stroke="currentColor" stroke-width="2" fill="none"/></svg>`,

  // ── Weapon card ──────────────────────────────────────────────────────
  weapon_default: `<svg viewBox="0 0 32 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="8" width="22" height="4"/><rect x="24" y="7" width="6" height="6"/><rect x="8" y="12" width="4" height="5"/></svg>`,
} as const;

export type GlyphId = keyof typeof GLYPHS;

export function glyph(id: GlyphId): string {
  return GLYPHS[id];
}
