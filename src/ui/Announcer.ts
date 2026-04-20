/**
 * Announcer — big center-top editorial callouts.
 *
 * Pipeline:
 *   announce(text, opts)  →  queue
 *   updateAnnouncer(dt)   →  dequeue → render → fade
 *   clearAnnouncer()      →  drop all
 *
 * EXTRA IDEA #1 — Letterbox bars.
 * Epic-tier announcements automatically get the `letterbox` class on
 * #announcer, which triggers the amber→hazard gradient bars that sweep
 * in from top and bottom of the viewport for 1.2s.  The CSS
 * (@keyframes letterboxIn in index.css) does all the work — this file
 * just toggles the class at the right moment.
 */

export type AnnouncementTier = 'small' | 'medium' | 'large' | 'epic';

interface Announcement {
  text: string;
  sub?: string;
  tier: AnnouncementTier;
  color: string;
  duration: number;
}

const queue: Announcement[] = [];
let current: Announcement | null = null;
let timer = 0;
let el: HTMLDivElement | null = null;

function ensureEl(): HTMLDivElement {
  if (el) return el;
  el = document.createElement('div');
  el.id = 'announcer';
  el.innerHTML = `
    <div class="anc-text" id="ancText"></div>
    <div class="anc-sub" id="ancSub"></div>
    <div class="anc-glow" id="ancGlow"></div>
  `;
  document.body.appendChild(el);
  return el;
}

export function announce(text: string, opts: Partial<Omit<Announcement, 'text'>> = {}): void {
  queue.push({
    text: text.toUpperCase(),
    sub: opts.sub,
    tier: opts.tier ?? 'medium',
    // Default color now matches the APEX signal amber, not the old gold.
    color: opts.color ?? '#ff8c1a',
    duration: opts.duration ?? 2.0,
  });
}

const TIER_CLASS: Record<AnnouncementTier, string> = {
  small:  'anc-small',
  medium: 'anc-medium',
  large:  'anc-large',
  epic:   'anc-epic',
};

export function updateAnnouncer(dt: number): void {
  const root = ensureEl();

  if (current) {
    timer -= dt;
    if (timer <= 0) {
      // Strip BOTH the .on class and .letterbox so the bars unwind.
      root.classList.remove('on', 'letterbox');
      current = null;
      timer = 0.25; // brief gap before next announcement
      return;
    }
  } else if (timer > 0) {
    timer -= dt;
    return;
  } else if (queue.length > 0) {
    current = queue.shift()!;
    timer = current.duration;

    const textEl = document.getElementById('ancText')!;
    const subEl  = document.getElementById('ancSub')!;
    const glowEl = document.getElementById('ancGlow')!;

    textEl.textContent = current.text;
    subEl.textContent  = current.sub ?? '';
    subEl.style.display = current.sub ? 'block' : 'none';

    // Reset class set, then apply tier + .on.
    root.className = '';
    root.id = 'announcer';
    root.classList.add(TIER_CLASS[current.tier], 'on');

    // EXTRA IDEA #1 — letterbox bars for EPIC tier only.
    // The CSS keyframe `letterboxIn` runs on pseudos of #announcer.letterbox.
    if (current.tier === 'epic') {
      root.classList.add('letterbox');
    }

    textEl.style.color = current.color;
    textEl.style.textShadow =
      `0 0 24px ${current.color}, 0 0 48px ${current.color}, 0 2px 6px rgba(0,0,0,0.9)`;
    glowEl.style.background =
      `radial-gradient(ellipse at center, ${current.color}22 0%, transparent 60%)`;
  }
}

export function clearAnnouncer(): void {
  queue.length = 0;
  current = null;
  timer = 0;
  if (el) el.classList.remove('on', 'letterbox');
}
