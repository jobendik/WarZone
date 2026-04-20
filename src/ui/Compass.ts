import { gameState } from '@/core/GameState';

/**
 * Compass — drives the APEX PROTOCOL top-center compass strip.
 *
 * Builds the preview's exact markup under #compassStrip:
 *   .hud-compass-tick.major  (every 45°)
 *   .hud-compass-tick.minor  (every 5°)
 *   .hud-compass-label.cardinal  (N / NE / E / SE / S / SW / W / NW)
 *   .hud-compass-label           (numeric degrees at 15° intervals)
 *
 * Spec §5 item 9 — ambient drift: the strip breathes ±0.35° around the
 * player's actual yaw so the HUD stays alive in idle frames.
 *
 * The preview uses 900px per 360°.  Strip is built at 2×
 * (0–720°) so the player can rotate continuously without seeing a seam.
 *
 * Public API preserved:
 *   updateCompass()   — called every frame from the game loop
 *   rebuildCompass()  — force rebuild after settings changes
 */

const SPACING_PX_PER_DEG = 900 / 360;   // 2.5 px per degree — matches preview
const STRIP_TOTAL_DEG = 720;            // render two full wraps

// Ambient drift state (§5 item 9)
let driftPhase = 0;
const DRIFT_AMPLITUDE_DEG = 0.35;
const DRIFT_RATE = 0.018;               // ~1 Hz at 60 fps

// DOM cache
let stripEl: HTMLElement | null = null;
let containerWidth = 0;
let built = false;
let lastRenderedEffectiveYaw = Number.NaN;

const CARDINALS: Record<number, string> = {
  0: 'N', 45: 'NE', 90: 'E', 135: 'SE',
  180: 'S', 225: 'SW', 270: 'W', 315: 'NW',
};

function buildStrip(strip: HTMLElement): void {
  strip.innerHTML = '';

  for (let deg = 0; deg < STRIP_TOTAL_DEG; deg += 5) {
    const actual = deg % 360;
    const x = deg * SPACING_PX_PER_DEG;
    const isMajor = actual % 45 === 0;

    // Tick mark
    const tick = document.createElement('div');
    tick.className = 'hud-compass-tick ' + (isMajor ? 'major' : 'minor');
    tick.style.left = `${x}px`;
    strip.appendChild(tick);

    // Label: cardinals at 45°, numeric at other 15° intervals
    if (CARDINALS[actual] !== undefined) {
      const lbl = document.createElement('div');
      lbl.className = 'hud-compass-label cardinal';
      lbl.style.left = `${x}px`;
      lbl.textContent = CARDINALS[actual];
      strip.appendChild(lbl);
    } else if (actual % 15 === 0) {
      const lbl = document.createElement('div');
      lbl.className = 'hud-compass-label';
      lbl.style.left = `${x}px`;
      lbl.textContent = String(actual);
      strip.appendChild(lbl);
    }
  }

  built = true;
}

export function updateCompass(): void {
  if (!stripEl) {
    stripEl = document.getElementById('compassStrip');
    if (!stripEl) return;
  }
  if (!built) {
    buildStrip(stripEl);
    containerWidth = stripEl.parentElement?.clientWidth ?? 360;
  }

  // Ambient drift (§5 item 9)
  driftPhase += DRIFT_RATE;
  if (driftPhase > Math.PI * 2) driftPhase -= Math.PI * 2;
  const drift = Math.sin(driftPhase) * DRIFT_AMPLITUDE_DEG;

  // Camera yaw in degrees.  In three.js: positive yaw rotates the camera
  // clockwise viewed from above, so negate to make the strip scroll
  // correctly (turning right slides ticks leftward on screen).
  const yawDeg = -((gameState.cameraYaw ?? 0) * 180 / Math.PI);

  // Normalize to [0, 360)
  const normalizedYaw = ((yawDeg % 360) + 360) % 360;
  const effectiveYaw = normalizedYaw + drift;

  // Skip DOM write when the strip would move less than 0.05px this frame
  if (!Number.isNaN(lastRenderedEffectiveYaw)) {
    const deltaPx = Math.abs(
      (effectiveYaw - lastRenderedEffectiveYaw) * SPACING_PX_PER_DEG,
    );
    if (deltaPx < 0.05) return;
  }
  lastRenderedEffectiveYaw = effectiveYaw;

  // Center current yaw in the viewport: strip starts at 0°, the needle
  // sits at containerWidth/2, so we translate so (effectiveYaw * spacing)
  // ends up at the center.
  const xOffset = (containerWidth / 2) - (effectiveYaw * SPACING_PX_PER_DEG);

  // Wrap to [-360°, 0°) worth of pixels so we don't accumulate float drift
  const wrapPx = 360 * SPACING_PX_PER_DEG;
  const wrapped = ((xOffset % wrapPx) + wrapPx) % wrapPx - wrapPx;

  stripEl.style.transform = `translate3d(${wrapped.toFixed(2)}px, 0, 0)`;
}

export function rebuildCompass(): void {
  built = false;
  if (stripEl) stripEl.innerHTML = '';
}
