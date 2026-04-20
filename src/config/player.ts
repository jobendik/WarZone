/** First-person player configuration */
export const FP = {
  height: 1.6,
  sensitivity: 0.0022,
  pitchMin: -1.3,
  pitchMax: 1.3,
  moveSpeed: 9,
  sprintSpeed: 13,
  playerRadius: 0.55,
  // Doubled effective jump height: h = v² / (2g).  Previously 5.5 → ~1.08m.
  // 7.78 ≈ 5.5 * √2 → ~2.16m apex.
  jumpVelocity: 7.78,
  gravity: 14,
  /** Max step height that can be auto-walked-over (e.g. building foundations) */
  stepHeight: 0.4,
};
