/**
 * Announcer — APEX PROTOCOL center-top tactical callouts.
 *
 * Writes to the preview's real selectors:
 *   #announcer.hud-announce (with tier class + .letterbox for epic)
 *     .an-kicker   "// ZONE B · 87% CAPTURED"
 *     .an-text     "HOLD THE LINE"
 *     .an-sub      "BLUE TEAM — PUSH SECONDARY"
 *
 * Tier classes on #announcer: .anc-small / .anc-medium / .anc-large / .anc-epic
 * Epic tier also gets `.letterbox` → triggers amber bar sweep from CSS.
 *
 * Public API preserved:
 *   announce(text, opts)
 *   updateAnnouncer(dt)
 *   clearAnnouncer()
 */

export type AnnouncementTier = 'small' | 'medium' | 'large' | 'epic';

interface Announcement {
  kicker?: string;
  text: string;
  sub?: string;
  tier: AnnouncementTier;
  duration: number;
}

const queue: Announcement[] = [];
let current: Announcement | null = null;
let timer = 0;

const TIER_CLASS: Record<AnnouncementTier, string> = {
  small:  'anc-small',
  medium: 'anc-medium',
  large:  'anc-large',
  epic:   'anc-epic',
};

function el(): HTMLElement | null { return document.getElementById('announcer'); }
function kickerEl(): HTMLElement | null { return document.getElementById('ancKicker'); }
function textEl(): HTMLElement | null   { return document.getElementById('ancText'); }
function subEl(): HTMLElement | null    { return document.getElementById('ancSub'); }

export function announce(
  text: string,
  opts: Partial<Omit<Announcement, 'text'>> & { color?: string } = {},
): void {
  queue.push({
    kicker:   opts.kicker,
    text:     text.toUpperCase(),
    sub:      opts.sub,
    tier:     opts.tier ?? 'medium',
    duration: opts.duration ?? 2.0,
  });
}

export function updateAnnouncer(dt: number): void {
  const root = el();
  if (!root) return;

  if (current) {
    timer -= dt;
    if (timer <= 0) {
      root.classList.remove('on', 'letterbox', 'anc-small', 'anc-medium', 'anc-large', 'anc-epic');
      root.style.display = 'none';
      current = null;
      timer = 0.25;
      return;
    }
  } else if (timer > 0) {
    timer -= dt;
    return;
  } else if (queue.length > 0) {
    current = queue.shift()!;
    timer = current.duration;

    const k = kickerEl(), t = textEl(), s = subEl();
    if (k) {
      if (current.kicker) {
        k.textContent = current.kicker;
        k.style.display = 'inline-block';
      } else {
        k.style.display = 'none';
      }
    }
    if (t) t.textContent = current.text;
    if (s) {
      if (current.sub) {
        s.textContent = current.sub;
        s.style.display = 'block';
      } else {
        s.style.display = 'none';
      }
    }

    // Reset classes, then apply tier + .on
    root.classList.remove('anc-small', 'anc-medium', 'anc-large', 'anc-epic', 'letterbox');
    root.classList.add(TIER_CLASS[current.tier], 'on');
    if (current.tier === 'epic') root.classList.add('letterbox');
    root.style.display = 'block';
  }
}

export function clearAnnouncer(): void {
  queue.length = 0;
  current = null;
  timer = 0;
  const root = el();
  if (root) {
    root.classList.remove('on', 'letterbox', 'anc-small', 'anc-medium', 'anc-large', 'anc-epic');
    root.style.display = 'none';
  }
}
