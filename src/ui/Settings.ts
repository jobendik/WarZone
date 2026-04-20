import { FP } from '@/config/player';
import { Audio } from '@/audio/AudioManager';
import { movement } from '@/movement/MovementController';
import { gameState } from '@/core/GameState';

const STORAGE_KEY = 'warzone_settings';

export interface GameSettings {
  sensitivity: number;
  fov: number;
  masterVol: number;
  sfxVol: number;
  musicVol: number;
  headBobScale: number;
  crosshairColor: string;
  crosshairSize: number;
  crosshairDot: boolean;
  botDifficulty: number;
  colorblindMode: string;
  showFPS: boolean;
  showSubtitles: boolean;
}

const defaults: GameSettings = {
  sensitivity: 0.0022,
  fov: 78,
  masterVol: 0.7,
  sfxVol: 1,
  musicVol: 0.5,
  headBobScale: 1,
  crosshairColor: '#f0faff',
  crosshairSize: 1,
  crosshairDot: true,
  botDifficulty: 0.5,
  colorblindMode: 'off',
  showFPS: false,
  showSubtitles: true,
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
  'headBobScale',
  'crosshairColor',
  'crosshairSize',
  'crosshairDot',
  'botDifficulty',
  'colorblindMode',
  'showFPS',
  'showSubtitles',
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

  gameState.crosshairColor = current.crosshairColor;
  gameState.crosshairSize = current.crosshairSize;
  gameState.crosshairDot = current.crosshairDot;
  gameState.botDifficulty = current.botDifficulty;
  gameState.colorblindMode = current.colorblindMode as any;
  gameState.showFPS = current.showFPS;
  gameState.showSubtitles = current.showSubtitles;

  document.body.classList.remove('cb-deuteranopia', 'cb-protanopia', 'cb-tritanopia');
  if (current.colorblindMode !== 'off') {
    document.body.classList.add(`cb-${current.colorblindMode}`);
  }

  const fpsEl = document.getElementById('fpsCounter');
  if (fpsEl) fpsEl.classList.toggle('hidden', !current.showFPS);

  const xh = document.getElementById('xh');
  if (xh) {
    xh.style.setProperty('--xh-color', current.crosshairColor);
    xh.style.transform = `scale(${current.crosshairSize})`;

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
    case 'headBobScale':
    case 'botDifficulty':
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
      return value ? 'ON' : 'OFF';

    default:
      return String(value);
  }
}

function getUiValueForControl(key: SettingKey, value: GameSettings[SettingKey]): string {
  switch (key) {
    case 'masterVol':
    case 'sfxVol':
    case 'musicVol':
    case 'headBobScale':
    case 'botDifficulty':
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
    case 'headBobScale':
    case 'botDifficulty':
      return (parseFloat(raw) / 100) as GameSettings[SettingKey];

    case 'sensitivity':
    case 'crosshairSize':
      return parseFloat(raw) as GameSettings[SettingKey];

    case 'fov':
      return parseInt(raw, 10) as GameSettings[SettingKey];

    case 'crosshairColor':
    case 'colorblindMode':
      return raw as GameSettings[SettingKey];

    case 'crosshairDot':
    case 'showFPS':
    case 'showSubtitles':
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

  for (const key of SETTING_KEYS) {
    const control = qControl(root, key);
    if (!control) continue;

    const commit = () => {
      current[key] = parseControlValue(key, control);
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
