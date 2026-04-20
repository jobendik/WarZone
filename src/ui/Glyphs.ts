/**
 * Glyphs — central SVG icon registry.
 *
 * Spec §8: "The Glyphs.ts module is the one addition worth making.
 * It holds every SVG icon used by the HUD (weapons, medals, modes,
 * map pips) so you have a single source of truth."
 *
 * All SVGs use `fill="currentColor"` so they inherit the parent's CSS
 * color and can be tinted via standard CSS.  Drop them into the DOM
 * via `element.innerHTML = glyph('heart')`.
 */

export const GLYPHS = {
  // ── Vitals ──────────────────────────────────────────────────────────
  heart: `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 14s-5-3.5-5-8a3 3 0 0 1 5-2.23A3 3 0 0 1 13 6c0 4.5-5 8-5 8z"/></svg>`,
  shield: `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 1 2 3v5c0 3.5 2.6 6.5 6 7 3.4-.5 6-3.5 6-7V3L8 1z"/></svg>`,
  grenade: `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="10" r="5"/><rect x="6" y="2" width="4" height="3"/><path d="M5 5h6v1H5z"/></svg>`,
  flashbang: `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="6" y="2" width="4" height="5"/><circle cx="8" cy="10" r="4"/><circle cx="8" cy="10" r="1.5" fill="#06070b"/></svg>`,
  smoke: `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="7" y="2" width="2" height="4"/><ellipse cx="8" cy="10" rx="5" ry="4"/></svg>`,

  // ── Medals (spec §4: amber/gold/silver/bronze tier borders) ────────
  medal_star: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><polygon points="12,2 15.09,9 22,10.27 17,15.14 18.18,22 12,18.77 5.82,22 7,15.14 2,10.27 8.91,9"/></svg>`,
  medal_diamond: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><polygon points="12,2 22,12 12,22 2,12"/></svg>`,
  medal_shield: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L4 6v6c0 5.5 3.8 10.7 8 12 4.2-1.3 8-6.5 8-12V6L12 2z"/></svg>`,
  medal_crosshair: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" stroke-width="2" fill="none"/></svg>`,
  medal_blade: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M4 20L20 4l-2 8-8 2z"/><circle cx="4" cy="20" r="2"/></svg>`,
  medal_x: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" xmlns="http://www.w3.org/2000/svg"><path d="M18 6L6 18M6 6l12 12" stroke-linecap="square"/></svg>`,
  medal_rocket: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C8 7 7 11 8 14l-3 3 1 2 2 1 3-3c3 1 7 0 12-4L12 2z"/></svg>`,
  medal_explosion: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="square"/></svg>`,
  medal_double: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="700" font-family="monospace">2×</text></svg>`,
  medal_triple: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="700" font-family="monospace">3×</text></svg>`,
  medal_quad: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><text x="12" y="17" text-anchor="middle" font-size="14" font-weight="700" font-family="monospace">4×</text></svg>`,
  medal_drop: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C8 8 6 11 6 14a6 6 0 0 0 12 0c0-3-2-6-6-12z"/></svg>`,
  medal_scope: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="7" stroke="currentColor" stroke-width="2"/><line x1="12" y1="17" x2="12" y2="22" stroke="currentColor" stroke-width="2"/><line x1="2" y1="12" x2="7" y2="12" stroke="currentColor" stroke-width="2"/><line x1="17" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="2"/></svg>`,
  medal_double_circle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="12" r="5"/><circle cx="16" cy="12" r="5"/></svg>`,
  medal_bolt: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13 2L4 14h6l-2 8 11-14h-7z"/></svg>`,
  medal_flag: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M5 2v20h2v-8h10l-2-4 2-4H7V2z"/></svg>`,

  // ── Mode cards (§3: 3×2 grid on main menu) ─────────────────────────
  mode_tdm: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><path d="M4 6h16M4 12h16M4 18h16"/></svg>`,
  mode_dom: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>`,
  mode_hardpoint: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><polygon points="12,3 22,20 2,20"/></svg>`,
  mode_sd: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" stroke-linecap="square"/></svg>`,
  mode_ctf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L4 6v6c0 5 3.5 9 8 10 4.5-1 8-5 8-10V6l-8-4z"/></svg>`,
  mode_ffa: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="7" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`,
  mode_br: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10"/><path d="M12 2L12 22 M2 12 L22 12 M5 5 L19 19 M19 5 L5 19"/></svg>`,

  // ── Map / objective pips ───────────────────────────────────────────
  pip_flag: `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="1" width="1" height="14"/><path d="M5 2h8l-2 3 2 3H5z"/></svg>`,
  pip_zone: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/></svg>`,

  // ── Weapon fallback ────────────────────────────────────────────────
  weapon_default: `<svg viewBox="0 0 32 20" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="8" width="22" height="4"/><rect x="24" y="7" width="6" height="6"/><rect x="8" y="12" width="4" height="5"/></svg>`,

  // ── Misc UI affordances ────────────────────────────────────────────
  chevron_right: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" xmlns="http://www.w3.org/2000/svg"><polyline points="9 6 15 12 9 18"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" xmlns="http://www.w3.org/2000/svg"><polyline points="4 12 10 18 20 6"/></svg>`,
  warning: `<svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M12 2 L22 20 L2 20 Z M11 9 h2 v6 h-2 z M11 16 h2 v2 h-2 z"/></svg>`,
  dot: `<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="4"/></svg>`,
} as const;

export type GlyphId = keyof typeof GLYPHS;

export function glyph(id: GlyphId): string {
  return GLYPHS[id];
}

/**
 * Injects an SVG glyph into an element with the given ID. Safe no-op
 * if the element doesn't exist yet.
 */
export function setGlyph(elId: string, glyphId: GlyphId): void {
  const el = document.getElementById(elId);
  if (el) el.innerHTML = GLYPHS[glyphId];
}
