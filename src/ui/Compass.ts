import { gameState } from '@/core/GameState';

/**
 * Compass — top-center heading strip.
 *
 * APEX PROTOCOL spec §5 item 9:
 *   "Ambient scan drift on the compass strip — a 0.3°/frame drift
 *    applied via JS transform even when the player isn't turning,
 *    so the HUD feels alive in idle frames."
 *
 * Implementation: we keep a tiny sinusoidal offset that breathes
 * ±0.35° around the player's actual yaw.  When the player is turning
 * fast, the drift becomes negligible relative to their input; when
 * they're standing still, it keeps the strip visibly alive instead
 * of frozen.
 *
 * Public API preserved:
 *   updateCompass()  — call every frame from the game loop
 */

const COMPASS_WIDTH = 720;          // px rendered width
const DEGREES_PER_PX = 360 / COMPASS_WIDTH;

// Ambient drift state — oscillates slowly to sell "scanning" motion.
let driftPhase = 0;                 // radians, advances every frame
const DRIFT_AMPLITUDE_DEG = 0.35;   // max degrees of sway (subtle)
const DRIFT_RATE = 0.018;           // phase advance per frame (~1 Hz at 60fps)

// Last-rendered yaw, so we only write to DOM when the strip actually
// needs to move (cheap optimisation — idle frames still update because
// of the drift, but we skip the DOM write when the delta is <0.05px).
let lastRenderedYaw = NaN;

// Cache the strip element once
let stripEl: HTMLElement | null = null;
let strokesBuilt = false;

/**
 * Build the tick marks + cardinals once. The strip renders two full
 * 360° arcs side-by-side so the player can rotate continuously without
 * seeing a seam.
 */
function buildStrip(strip: HTMLElement): void {
  if (strokesBuilt) return;

  const parts: string[] = [];

  // Render from -180° to +540° (two full wraps) so there's always
  // content on either side of the 0-point as the player rotates.
  for (let deg = -180; deg <= 540; deg += 15) {
    const normalized = ((deg % 360) + 360) % 360;
    const posPx = (deg + 180) * (COMPASS_WIDTH / 360);

    let label = '';
    let cls = 'compass-tick';
    if (normalized === 0)        { label = 'N';  cls += ' compass-tick-cardinal'; }
    else if (normalized === 90)  { label = 'E';  cls += ' compass-tick-cardinal'; }
    else if (normalized === 180) { label = 'S';  cls += ' compass-tick-cardinal'; }
    else if (normalized === 270) { label = 'W';  cls += ' compass-tick-cardinal'; }
    else if (normalized % 45 === 0) {
      // Inter-cardinal labels (NE, SE, SW, NW)
      const interCardinals: Record<number, string> = {
        45: 'NE', 135: 'SE', 225: 'SW', 315: 'NW',
      };
      label = interCardinals[normalized] ?? '';
      cls += ' compass-tick-inter';
    } else {
      label = `${normalized}`;
      cls += ' compass-tick-minor';
    }

    parts.push(
      `<div class="${cls}" style="left:${posPx.toFixed(1)}px">` +
        `<div class="compass-tick-mark"></div>` +
        (label ? `<div class="compass-tick-label">${label}</div>` : '') +
      `</div>`,
    );
  }

  strip.innerHTML = parts.join('');
  strip.style.width = `${COMPASS_WIDTH * 2}px`;
  strokesBuilt = true;
}

export function updateCompass(): void {
  if (!stripEl) {
    stripEl = document.getElementById('compassStrip');
    if (!stripEl) return;
    buildStrip(stripEl);
  }

  // EXTRA IDEA #9 — ambient drift.
  // Advance phase every frame, then compute a sinusoidal offset.
  driftPhase += DRIFT_RATE;
  if (driftPhase > Math.PI * 2) driftPhase -= Math.PI * 2;
  const drift = Math.sin(driftPhase) * DRIFT_AMPLITUDE_DEG;

  // Camera yaw (radians) → degrees. In our engine, positive yaw rotates
  // the camera clockwise when viewed from above, so we negate here to
  // make the strip scroll the correct direction: turning right moves
  // tick marks leftward on screen.
  const yawDeg = -(gameState.cameraYaw ?? 0) * 180 / Math.PI;

  // Combined effective yaw (drift added on top of player yaw).
  const effectiveYaw = yawDeg + drift;

  // Skip DOM write if the strip would move less than 0.05px this frame
  // — avoids layout thrash during perfect standstill.
  if (!Number.isNaN(lastRenderedYaw)) {
    const deltaPx = Math.abs((effectiveYaw - lastRenderedYaw) / DEGREES_PER_PX);
    if (deltaPx < 0.05) return;
  }
  lastRenderedYaw = effectiveYaw;

  // Translate the strip: 1° of yaw = (COMPASS_WIDTH/360) pixels.
  // The indicator is fixed in the center, so we slide the strip under it.
  const offsetPx = -effectiveYaw * (COMPASS_WIDTH / 360);

  // Wrap the transform so the strip never scrolls more than ±COMPASS_WIDTH.
  // This keeps the number stable (no floating-point drift over hours of play).
  const wrappedOffset = ((offsetPx % COMPASS_WIDTH) + COMPASS_WIDTH) % COMPASS_WIDTH - COMPASS_WIDTH / 2;

  stripEl.style.transform = `translate3d(${wrappedOffset.toFixed(2)}px, 0, 0)`;
}

/**
 * Called when the compass needs to be fully rebuilt (e.g. after a
 * settings change that re-skins the tick marks).
 */
export function rebuildCompass(): void {
  strokesBuilt = false;
  if (stripEl) stripEl.innerHTML = '';
}
