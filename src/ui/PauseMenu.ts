import { gameState } from '@/core/GameState';

/**
 * PauseMenu — APEX PROTOCOL left drawer pause UI.
 *
 * Emits the preview's .pz-shell markup:
 *   #pauseDrawer.on
 *     .pz-shell
 *       .pz-kicker    "// SIMULATION HALTED"
 *       .pz-title     "Stand Down."
 *       .pz-meta      "Mode · Map · Time · Score"
 *       .pz-opts
 *         .pz-opt [ESC]  RESUME    ▸
 *         .pz-opt [01]   SETTINGS  ▸
 *         .pz-opt [02]   CONTROLS  ▸
 *         .pz-opt [03]   LOADOUT   ▸
 *         .pz-opt [04]   RESTART   ▸
 *         .pz-opt.danger [05] QUIT ▸
 *
 * Behaviour:
 *   - ESC opens / closes
 *   - Number keys 1–5 trigger the corresponding row
 *   - Each row fires the callback registered via initPauseMenu()
 *
 * Public API:
 *   initPauseMenu(callbacks)
 *   showPauseMenu()
 *   hidePausedMenu()  / hidePauseMenu()
 *   isPauseMenuOpen()
 */

export interface PauseMenuCallbacks {
  onResume?: () => void;
  onSettings?: () => void;
  onControls?: () => void;
  onLoadout?: () => void;
  onRestart?: () => void;
  onQuit?: () => void;
}

let drawerEl: HTMLDivElement | null = null;
let metaEl: HTMLElement | null = null;
let cbs: PauseMenuCallbacks = {};
let open = false;
let keyListener: ((e: KeyboardEvent) => void) | null = null;

// ── Build the drawer DOM once ──────────────────────────────────────────
function ensureDrawer(): HTMLDivElement {
  if (drawerEl) return drawerEl;

  drawerEl = document.createElement('div');
  drawerEl.id = 'pauseDrawer';
  drawerEl.innerHTML = `
    <div class="pz-shell">
      <div class="pz-kicker">// SIMULATION HALTED</div>
      <h1 class="pz-title">Stand<br/>Down.</h1>
      <div class="pz-meta" id="pzMeta">—</div>

      <div class="pz-opts">
        <button class="pz-opt" data-action="resume">
          <span class="pz-opt-key">ESC</span>
          <span class="pz-opt-label">RESUME</span>
          <span class="pz-opt-arrow">▸</span>
        </button>
        <button class="pz-opt" data-action="settings">
          <span class="pz-opt-key">01</span>
          <span class="pz-opt-label">SETTINGS</span>
          <span class="pz-opt-arrow">▸</span>
        </button>
        <button class="pz-opt" data-action="controls">
          <span class="pz-opt-key">02</span>
          <span class="pz-opt-label">CONTROLS</span>
          <span class="pz-opt-arrow">▸</span>
        </button>
        <button class="pz-opt" data-action="loadout">
          <span class="pz-opt-key">03</span>
          <span class="pz-opt-label">LOADOUT</span>
          <span class="pz-opt-arrow">▸</span>
        </button>
        <button class="pz-opt" data-action="restart">
          <span class="pz-opt-key">04</span>
          <span class="pz-opt-label">RESTART MATCH</span>
          <span class="pz-opt-arrow">▸</span>
        </button>
        <button class="pz-opt danger" data-action="quit">
          <span class="pz-opt-key">05</span>
          <span class="pz-opt-label">QUIT TO LOBBY</span>
          <span class="pz-opt-arrow">▸</span>
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(drawerEl);
  metaEl = drawerEl.querySelector('#pzMeta') as HTMLElement;

  // Wire clicks
  drawerEl.querySelectorAll('.pz-opt').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = (btn as HTMLElement).dataset.action;
      handleAction(action ?? '');
    });
  });

  return drawerEl;
}

function handleAction(action: string): void {
  switch (action) {
    case 'resume':   hidePauseMenu(); cbs.onResume?.();   break;
    case 'settings': cbs.onSettings?.();                   break;
    case 'controls': cbs.onControls?.();                   break;
    case 'loadout':  cbs.onLoadout?.();                    break;
    case 'restart':  hidePauseMenu(); cbs.onRestart?.();  break;
    case 'quit':     hidePauseMenu(); cbs.onQuit?.();     break;
  }
}

function updateMeta(): void {
  if (!metaEl) return;
  const mode = (gameState.mode ?? 'TDM').toString().toUpperCase();
  const timeRem = Math.max(0, Math.floor(gameState.matchTimeRemaining ?? 0));
  const m = Math.floor(timeRem / 60), s = timeRem % 60;
  const timeStr = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  const blue = gameState.scoreBlue ?? 0;
  const red  = gameState.scoreRed  ?? 0;
  metaEl.textContent = `${mode} · ${timeStr} remaining · ${blue} — ${red}`;
}

// ── Public API ─────────────────────────────────────────────────────────
export function initPauseMenu(callbacks: PauseMenuCallbacks = {}): void {
  cbs = { ...cbs, ...callbacks };
  ensureDrawer();

  if (keyListener) return;   // wire once
  keyListener = (e: KeyboardEvent) => {
    if (!open) return;
    if (e.code === 'Escape')   { e.preventDefault(); handleAction('resume');   return; }
    if (e.code === 'Digit1')   { e.preventDefault(); handleAction('settings'); return; }
    if (e.code === 'Digit2')   { e.preventDefault(); handleAction('controls'); return; }
    if (e.code === 'Digit3')   { e.preventDefault(); handleAction('loadout');  return; }
    if (e.code === 'Digit4')   { e.preventDefault(); handleAction('restart');  return; }
    if (e.code === 'Digit5')   { e.preventDefault(); handleAction('quit');     return; }
  };
  window.addEventListener('keydown', keyListener, true);
}

export function showPauseMenu(): void {
  const d = ensureDrawer();
  updateMeta();
  d.classList.add('on');
  open = true;
  document.exitPointerLock?.();
}

export function hidePauseMenu(): void {
  if (drawerEl) drawerEl.classList.remove('on');
  open = false;
}
// Alias — a few callers use the misspelled name
export const hidePausedMenu = hidePauseMenu;

export function isPauseMenuOpen(): boolean { return open; }

export function togglePauseMenu(): void {
  if (open) hidePauseMenu();
  else showPauseMenu();
}
