import { FP } from '@/config/player';
import { Audio } from '@/audio/AudioManager';
import { movement } from '@/movement/MovementController';
import { gameState } from '@/core/GameState';
import { getSunLight } from '@/world/Lights';

const STORAGE_KEY = 'warzone_settings';

export interface GameSettings {
  sensitivity: number;
  fov: number;
  masterVol: number;
  sfxVol: number;
  musicVol: number;
  voiceVol: number;
  uiVol: number;
  headBobScale: number;
  crosshairColor: string;
  crosshairSize: number;
  crosshairDot: boolean;
  botDifficulty: number;
  colorblindMode: string;
  showFPS: boolean;
  showSubtitles: boolean;
  particleQuality: number;   // 0-1: 0 = low, 0.5 = medium, 1 = high
  shadowMapSize: number;     // 512, 1024, or 2048
  enableBotVoice: boolean;
}

const defaults: GameSettings = {
  sensitivity: 0.0022,
  fov: 78,
  masterVol: 0.7,
  sfxVol: 1,
  musicVol: 0.5,
  voiceVol: 1,
  uiVol: 0.8,
  headBobScale: 1,
  crosshairColor: '#f0faff',
  crosshairSize: 1,
  crosshairDot: true,
  botDifficulty: 0.5,
  colorblindMode: 'off',
  showFPS: false,
  showSubtitles: true,
  particleQuality: 1,
  shadowMapSize: 1024,
  enableBotVoice: false,
};

let current: GameSettings = { ...defaults };

type SettingKey = keyof GameSettings;
type ControlEl = HTMLInputElement | HTMLSelectElement;

const SETTING_KEYS: SettingKey[] = [
  'sensitivity',
  'fov',
  'masterVol',
  'sfxVol',
  'musicVol',
  'voiceVol',
  'uiVol',
  'headBobScale',
  'crosshairColor',
  'crosshairSize',
  'crosshairDot',
  'botDifficulty',
  'colorblindMode',
  'showFPS',
  'showSubtitles',
  'particleQuality',
  'shadowMapSize',
  'enableBotVoice',
];

export function getSettings(): Readonly<GameSettings> {
  return current;
}

export function loadSettings(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      current = { ...defaults, ...parsed };
    }
  } catch {
    // ignore
  }
  applySettings();
}

function saveSettings(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // ignore
  }
}

export function applySettings(): void {
  FP.sensitivity = current.sensitivity;

  movement.fovBase = current.fov;
  movement.fovTarget = current.fov;
  movement.fovCurrent = current.fov;
  movement.headBobScale = current.headBobScale;

  Audio.setMaster(current.masterVol);
  Audio.setSfx(current.sfxVol);
  Audio.setMusic(current.musicVol);
  Audio.setVoice(current.voiceVol);
  Audio.setUi(current.uiVol);

  gameState.crosshairColor = current.crosshairColor;
  gameState.crosshairSize = current.crosshairSize;
  gameState.crosshairDot = current.crosshairDot;
  gameState.botDifficulty = current.botDifficulty;
  gameState.colorblindMode = current.colorblindMode as any;
  gameState.showFPS = current.showFPS;
  gameState.showSubtitles = current.showSubtitles;

  // Shadow map size — update the sun's shadow map when changed
  const sun = getSunLight?.();
  if (sun?.shadow) {
    const sz = current.shadowMapSize || 1024;
    if (sun.shadow.mapSize.x !== sz) {
      sun.shadow.mapSize.set(sz, sz);
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
        sun.shadow.map = null as any;
      }
      sun.shadow.needsUpdate = true;
    }
  }

  document.body.classList.remove('cb-deuteranopia', 'cb-protanopia', 'cb-tritanopia');
  if (current.colorblindMode !== 'off') {
    document.body.classList.add(`cb-${current.colorblindMode}`);
  }

  const fpsEl = document.getElementById('fpsCounter');
  if (fpsEl) fpsEl.classList.toggle('hidden', !current.showFPS);

  const xh = document.getElementById('xh');
  if (xh) {
    xh.style.setProperty('--xh-color', current.crosshairColor);
    xh.style.setProperty('--xh-size', String(current.crosshairSize));

    const dot = xh.querySelector('.xh-dot') as HTMLElement | null;
    if (dot) dot.style.display = current.crosshairDot ? '' : 'none';
  }
}

function qControl(root: ParentNode, key: SettingKey): ControlEl | null {
  return root.querySelector(`[data-setting="${key}"]`) as ControlEl | null;
}

function qValue(root: ParentNode, key: SettingKey): HTMLElement | null {
  return root.querySelector(`[data-setting-value="${key}"]`) as HTMLElement | null;
}

function formatValue(key: SettingKey, value: GameSettings[SettingKey]): string {
  switch (key) {
    case 'masterVol':
    case 'sfxVol':
    case 'musicVol':
    case 'voiceVol':
    case 'uiVol':
    case 'headBobScale':
    case 'botDifficulty':
    case 'particleQuality':
      return `${Math.round(Number(value) * 100)}%`;

    case 'sensitivity':
      return Number(value).toFixed(4);

    case 'crosshairSize':
      return Number(value).toFixed(1);

    case 'crosshairColor':
      return String(value);

    case 'crosshairDot':
    case 'showFPS':
    case 'showSubtitles':
    case 'enableBotVoice':
      return value ? 'ON' : 'OFF';

    case 'shadowMapSize':
      return `${value}px`;

    default:
      return String(value);
  }
}

function getUiValueForControl(key: SettingKey, value: GameSettings[SettingKey]): string {
  switch (key) {
    case 'masterVol':
    case 'sfxVol':
    case 'musicVol':
    case 'voiceVol':
    case 'uiVol':
    case 'headBobScale':
    case 'botDifficulty':
    case 'particleQuality':
      return String(Math.round(Number(value) * 100));

    default:
      return String(value);
  }
}

function parseControlValue(key: SettingKey, control: ControlEl): GameSettings[SettingKey] {
  if (control instanceof HTMLInputElement && control.type === 'checkbox') {
    return control.checked as GameSettings[SettingKey];
  }

  const raw = control.value;

  switch (key) {
    case 'masterVol':
    case 'sfxVol':
    case 'musicVol':
    case 'voiceVol':
    case 'uiVol':
    case 'headBobScale':
    case 'botDifficulty':
    case 'particleQuality':
      return (parseFloat(raw) / 100) as GameSettings[SettingKey];

    case 'sensitivity':
    case 'crosshairSize':
      return parseFloat(raw) as GameSettings[SettingKey];

    case 'fov':
    case 'shadowMapSize':
      return parseInt(raw, 10) as GameSettings[SettingKey];

    case 'crosshairColor':
    case 'colorblindMode':
      return raw as GameSettings[SettingKey];

    case 'crosshairDot':
    case 'showFPS':
    case 'showSubtitles':
    case 'enableBotVoice':
      return Boolean((control as HTMLInputElement).checked) as GameSettings[SettingKey];

    default:
      return raw as GameSettings[SettingKey];
  }
}

export function syncSettingsPanel(root: ParentNode): void {
  for (const key of SETTING_KEYS) {
    const control = qControl(root, key);
    const valueEl = qValue(root, key);

    if (control instanceof HTMLInputElement && control.type === 'checkbox') {
      control.checked = Boolean(current[key]);
    } else if (control) {
      control.value = getUiValueForControl(key, current[key]);
    }

    if (valueEl) {
      valueEl.textContent = formatValue(key, current[key]);
    }
  }
}

export function bindSettingsPanel(root: ParentNode): void {
  syncSettingsPanel(root);

  const assignSetting = <K extends SettingKey>(key: K, value: GameSettings[K]) => {
    current = { ...current, [key]: value };
  };

  for (const key of SETTING_KEYS) {
    const control = qControl(root, key);
    if (!control) continue;

    const commit = () => {
      assignSetting(key, parseControlValue(key, control));
      const valueEl = qValue(root, key);
      if (valueEl) valueEl.textContent = formatValue(key, current[key]);
      applySettings();
      saveSettings();
    };

    if (control instanceof HTMLSelectElement) {
      control.onchange = commit;
    } else if (control instanceof HTMLInputElement && control.type === 'checkbox') {
      control.onchange = commit;
    } else {
      control.oninput = commit;
      control.onchange = commit;
    }
  }
}

export function initSettings(): void {
  loadSettings();
}

let settingsOverlayEl: HTMLDivElement | null = null;

function renderSettingsOverlay(): string {
  return `
    <div class="ps-settings-shell">
      <div class="ps-settings-head">
        <div>
          <div class="ps-settings-kicker">// TACTICAL CONFIG</div>
          <div class="ps-settings-title">Settings</div>
        </div>
        <button class="ps-settings-close" type="button" data-close-settings>BACK</button>
      </div>
      <div class="ps-settings-body mm-settings">
        <div class="mm-setting-group">
          <div class="mm-section-head">AUDIO</div>
          <div class="mm-setting-row"><label>Master Volume</label><input type="range" min="0" max="100" step="5" data-setting="masterVol"/><span data-setting-value="masterVol">100%</span></div>
          <div class="mm-setting-row"><label>Music</label><input type="range" min="0" max="100" step="5" data-setting="musicVol"/><span data-setting-value="musicVol">50%</span></div>
          <div class="mm-setting-row"><label>SFX</label><input type="range" min="0" max="100" step="5" data-setting="sfxVol"/><span data-setting-value="sfxVol">100%</span></div>
          <div class="mm-setting-row"><label>Voice / Announcer</label><input type="range" min="0" max="100" step="5" data-setting="voiceVol"/><span data-setting-value="voiceVol">100%</span></div>
          <div class="mm-setting-row"><label>UI</label><input type="range" min="0" max="100" step="5" data-setting="uiVol"/><span data-setting-value="uiVol">80%</span></div>
          <div class="mm-setting-row"><label>Bot Voice TTS</label><label class="mm-checkbox"><input type="checkbox" data-setting="enableBotVoice"/><span>Enabled</span></label><span data-setting-value="enableBotVoice">ON</span></div>
        </div>

        <div class="mm-setting-group">
          <div class="mm-section-head">VISUALS</div>
          <div class="mm-setting-row"><label>FOV</label><input type="range" min="60" max="110" step="1" data-setting="fov"/><span data-setting-value="fov">78</span></div>
          <div class="mm-setting-row"><label>Crosshair Color</label><input type="color" data-setting="crosshairColor"/><span data-setting-value="crosshairColor">#f0faff</span></div>
          <div class="mm-setting-row"><label>Crosshair Size</label><input type="range" min="0.5" max="2" step="0.1" data-setting="crosshairSize"/><span data-setting-value="crosshairSize">1.0</span></div>
          <div class="mm-setting-row"><label>Crosshair Dot</label><label class="mm-checkbox"><input type="checkbox" data-setting="crosshairDot"/><span>Enabled</span></label><span data-setting-value="crosshairDot">ON</span></div>
          <div class="mm-setting-row"><label>Colorblind Mode</label><select data-setting="colorblindMode"><option value="off">Off</option><option value="deuteranopia">Deuteranopia</option><option value="protanopia">Protanopia</option><option value="tritanopia">Tritanopia</option></select><span data-setting-value="colorblindMode">off</span></div>
        </div>

        <div class="mm-setting-group">
          <div class="mm-section-head">CONTROLS & GAMEPLAY</div>
          <div class="mm-setting-row"><label>Mouse Sensitivity</label><input type="range" min="0.0005" max="0.006" step="0.0001" data-setting="sensitivity"/><span data-setting-value="sensitivity">0.0022</span></div>
          <div class="mm-setting-row"><label>Head Bob</label><input type="range" min="0" max="100" step="5" data-setting="headBobScale"/><span data-setting-value="headBobScale">100%</span></div>
          <div class="mm-setting-row"><label>Bot Difficulty</label><input type="range" min="0" max="100" step="10" data-setting="botDifficulty"/><span data-setting-value="botDifficulty">50%</span></div>
          <div class="mm-setting-row"><label>Show FPS</label><label class="mm-checkbox"><input type="checkbox" data-setting="showFPS"/><span>Enabled</span></label><span data-setting-value="showFPS">OFF</span></div>
          <div class="mm-setting-row"><label>Subtitles</label><label class="mm-checkbox"><input type="checkbox" data-setting="showSubtitles"/><span>Enabled</span></label><span data-setting-value="showSubtitles">ON</span></div>
        </div>

        <div class="mm-setting-group">
          <div class="mm-section-head">PERFORMANCE</div>
          <div class="mm-setting-row"><label>Particle Quality</label><input type="range" min="0" max="100" step="50" data-setting="particleQuality"/><span data-setting-value="particleQuality">100%</span></div>
          <div class="mm-setting-row"><label>Shadow Map Size</label><select data-setting="shadowMapSize"><option value="512">512 (Low)</option><option value="1024">1024 (Medium)</option><option value="2048">2048 (High)</option></select><span data-setting-value="shadowMapSize">1024px</span></div>
        </div>
      </div>
    </div>
  `;
}

function ensureSettingsOverlay(): HTMLDivElement {
  if (settingsOverlayEl?.isConnected) return settingsOverlayEl;

  settingsOverlayEl = document.createElement('div');
  settingsOverlayEl.id = 'pauseSettingsOverlay';
  settingsOverlayEl.innerHTML = renderSettingsOverlay();
  settingsOverlayEl.addEventListener('click', (event) => {
    if (event.target === settingsOverlayEl) hideSettingsOverlay();
  });

  settingsOverlayEl.querySelector('[data-close-settings]')?.addEventListener('click', () => hideSettingsOverlay());

  document.body.appendChild(settingsOverlayEl);
  bindSettingsPanel(settingsOverlayEl);
  return settingsOverlayEl;
}

export function openSettingsOverlay(): void {
  const overlay = ensureSettingsOverlay();
  syncSettingsPanel(overlay);
  overlay.classList.add('on');
}

export function hideSettingsOverlay(): void {
  settingsOverlayEl?.classList.remove('on');
}

export function isSettingsOverlayOpen(): boolean {
  return settingsOverlayEl?.classList.contains('on') ?? false;
}
