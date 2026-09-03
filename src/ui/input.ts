/**
 * ui/input.ts — InputManager (CONTRACT §8). Three sources — keyboard, touch,
 * gamepad — merged into one `FrameInput` for the player each frame. Any source
 * may drive any field; sticks add, buttons OR.
 *
 * Key / button map
 *   move      WASD / arrows · touch joystick (left half) · pad left stick / d-pad
 *   jab       J · diamond top    · pad Y (top face)
 *   cross     K · diamond right  · pad B (right face)
 *   hook      L · diamond left   · pad X (left face)
 *   uppercut  ; · diamond bottom · pad A (bottom face)
 *   block     Space · block button below the diamond · any shoulder / trigger
 *
 * Punch flags are LEVELS (true while held); the sim edge-triggers. Block is a
 * level. Key repeat is ignored. Everything releases on window blur.
 *
 * Screen → opponent-relative mapping
 *   The stick/keys are camera-relative: stick right = screen right, stick up =
 *   screen up (away from the camera on the floor). With the broadcast camera at
 *   azimuth `az` (cfg.camAzimuthDeg; the camera sits at (cos az, sin az) from
 *   the look point, so at the default 90° it sits at +z looking along −z):
 *     screenRight (floor) = ( sin az, −cos az)     → +x at 90°
 *     screenUp    (floor) = (−cos az, −sin az)     → −z at 90°
 *     world = sx·screenRight + su·screenUp          (su = −sy, DOM y is down)
 *   That floor vector is then expressed in the player's frame (core frameOf):
 *     move.y = dot(world, fwd)     toward (+) / away from (−) the opponent
 *     move.x = dot(world, right)   the fighter's own right (+) / left (−)
 *   and clamped to magnitude ≤ 1. At yaw 0 (facing +x) with the default camera:
 *   D → move.y = +1, A → −1, W → move.x = −1 (screen-up is −z = the fighter's
 *   left), S → +1. The sim reads sign(move.x) at press for hook/uppercut hand.
 *
 * Test hook: window.__input = { current, keys, touch: { joystick, buttons } }.
 */
import { frameOf, type Config, type FrameInput } from '../core';

export interface InputOptions {
  /** Yaw of the player fighter, read every `current()` call. */
  yaw: () => number;
  /** Mount the touch controls (floating joystick + diamond + block). */
  touch: boolean;
  /** Parent for the touch DOM; defaults to document.body. */
  root?: HTMLElement;
}

type Flag = 'jab' | 'cross' | 'hook' | 'uppercut' | 'block';
const FLAGS: readonly Flag[] = ['jab', 'cross', 'hook', 'uppercut', 'block'];

/** Keyboard map by KeyboardEvent.code (layout-independent physical keys). */
const KEY_FLAGS: Readonly<Record<string, Flag>> = {
  KeyJ: 'jab', KeyK: 'cross', KeyL: 'hook', Semicolon: 'uppercut', Space: 'block',
};
const KEY_MOVE: Readonly<Record<string, readonly [number, number]>> = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};

/** Standard-mapping gamepad buttons (w3c "standard"): 0 A, 1 B, 2 X, 3 Y, 4–7 shoulders/triggers, 12–15 d-pad. */
const PAD_FLAGS: readonly (readonly [number, Flag])[] = [
  [3, 'jab'], [1, 'cross'], [2, 'hook'], [0, 'uppercut'],
  [4, 'block'], [5, 'block'], [6, 'block'], [7, 'block'],
];
const PAD_DPAD: readonly (readonly [number, number, number])[] = [
  [12, 0, -1], [13, 0, 1], [14, -1, 0], [15, 1, 0],
];

const CSS = `
#touch-ui { position: fixed; inset: 0; z-index: 15; pointer-events: none; overflow: hidden;
  font: 11px/1.2 ui-monospace, Menlo, monospace; color: #fff; user-select: none; -webkit-user-select: none;
  -webkit-touch-callout: none; }
#touch-ui * { touch-action: none; user-select: none; -webkit-user-select: none; }
#touch-zone { position: absolute; left: 0; top: 0; width: 50%; height: 100%; pointer-events: auto; }
#touch-joy-base, #touch-joy-knob { position: absolute; border-radius: 50%; transform: translate(-50%, -50%); display: none; }
#touch-joy-base { background: rgba(0,0,0,.18); border: 3px solid rgba(255,255,255,.28); }
#touch-joy-knob { background: rgba(255,255,255,.55); border: 2px solid rgba(255,255,255,.45); }
#touch-ui.joy-on #touch-joy-base, #touch-ui.joy-on #touch-joy-knob { display: block; }
.touch-btn { position: absolute; transform: translate(-50%, -50%); pointer-events: auto; display: flex;
  align-items: center; justify-content: center; text-align: center; white-space: pre; letter-spacing: .04em;
  background: rgba(42,42,85,.65); border: 2px solid rgba(119,119,170,.55); border-radius: 50%; color: #fff; }
.touch-btn.block { background: rgba(85,34,34,.65); border-color: rgba(170,119,119,.55); border-radius: 10px; }
.touch-btn.on { background: rgba(255,255,255,.85); border-color: #fff; color: #1a1a2e; }
`;

export class InputManager {
  private readonly keys = new Set<string>();
  private readonly touchFlags = new Set<Flag>();
  private joy: { id: number; bx: number; by: number; x: number; y: number } | null = null;

  private ui: HTMLElement | null = null;
  private joyBase: HTMLElement | null = null;
  private joyKnob: HTMLElement | null = null;
  private buttons = new Map<Flag, HTMLElement>();
  private layoutKey = '';
  private readonly disposers: (() => void)[] = [];

  constructor(private readonly cfg: Config, private readonly opts: InputOptions) {
    this.listen(window, 'keydown', (e: KeyboardEvent) => this.onKey(e, true));
    this.listen(window, 'keyup', (e: KeyboardEvent) => this.onKey(e, false));
    this.listen(window, 'blur', () => this.releaseAll());
    this.listen(document, 'visibilitychange', () => { if (document.hidden) this.releaseAll(); });
    if (opts.touch) this.mountTouch(opts.root ?? document.body);

    window.__input = {
      current: () => this.current(),
      keys: () => [...this.keys],
      touch: {
        joystick: null, buttons: [],
      },
    };
    // Live getters so a test reads the current state, not a snapshot.
    Object.defineProperties(window.__input.touch, {
      joystick: { get: () => (this.joy ? { x: this.joy.x, y: this.joy.y } : null), enumerable: true },
      buttons: { get: () => [...this.touchFlags], enumerable: true },
    });
  }

  // ── Per-frame ───────────────────────────────────────────────────────────────

  /** The merged FrameInput for this frame (fresh object). */
  current(): FrameInput {
    this.layoutTouch();
    const out: FrameInput = { move: { x: 0, y: 0 }, jab: false, cross: false, hook: false, uppercut: false, block: false };

    // Screen-space stick: +x right, +y down (DOM convention). Each source adds.
    let sx = 0, sy = 0;
    let kx = 0, ky = 0;
    for (const code of this.keys) {
      const m = KEY_MOVE[code];
      if (m) { kx += m[0]; ky += m[1]; }
    }
    const kl = Math.hypot(kx, ky);
    if (kl > 1) { kx /= kl; ky /= kl; }
    sx += kx; sy += ky;
    if (this.joy) { sx += this.joy.x; sy += this.joy.y; }

    for (const code of this.keys) {
      const f = KEY_FLAGS[code];
      if (f) out[f] = true;
    }
    for (const f of this.touchFlags) out[f] = true;

    const pad = this.gamepad();
    if (pad) {
      const ax = pad.axes[0] ?? 0, ay = pad.axes[1] ?? 0;
      const al = Math.hypot(ax, ay);
      const dz = this.cfg.padDeadZone;
      if (al > dz) {
        const s = Math.min(1, (al - dz) / (1 - dz)) / al;
        sx += ax * s; sy += ay * s;
      }
      for (const [i, dx, dy] of PAD_DPAD) if (pad.buttons[i]?.pressed) { sx += dx; sy += dy; }
      for (const [i, f] of PAD_FLAGS) if (pad.buttons[i]?.pressed) out[f] = true;
    }

    const sl = Math.hypot(sx, sy);
    if (sl > 1) { sx /= sl; sy /= sl; }
    if (sl > 1e-6) {
      // Screen → world floor (see header), then world → the player's frame.
      const az = this.cfg.camAzimuthDeg * Math.PI / 180;
      const su = -sy;
      const wx = sx * Math.sin(az) - su * Math.cos(az);
      const wz = -sx * Math.cos(az) - su * Math.sin(az);
      const fr = frameOf(this.opts.yaw());
      let my = wx * fr.fwd.x + wz * fr.fwd.z;
      let mx = wx * fr.right.x + wz * fr.right.z;
      const ml = Math.hypot(mx, my);
      if (ml > 1) { mx /= ml; my /= ml; }
      out.move.x = mx; out.move.y = my;
    }
    return out;
  }

  /** Drop every held key/button/stick (blur, hidden tab, dispose). */
  releaseAll(): void {
    this.keys.clear();
    this.touchFlags.clear();
    this.joy = null;
    this.ui?.classList.remove('joy-on');
    for (const el of this.buttons.values()) el.classList.remove('on');
  }

  dispose(): void {
    this.releaseAll();
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.ui?.remove();
    this.ui = null;
  }

  // ── Keyboard ────────────────────────────────────────────────────────────────

  private onKey(e: KeyboardEvent, down: boolean): void {
    const code = e.code;
    if (!(code in KEY_FLAGS) && !(code in KEY_MOVE)) return;
    // Typing into the tuning panel's number fields must not move the fighter.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    if (e.repeat) return;
    if (down) this.keys.add(code); else this.keys.delete(code);
  }

  // ── Gamepad ─────────────────────────────────────────────────────────────────

  private gamepad(): Gamepad | null {
    if (typeof navigator.getGamepads !== 'function') return null;
    for (const g of navigator.getGamepads()) if (g && g.connected) return g;
    return null;
  }

  // ── Touch DOM ───────────────────────────────────────────────────────────────

  private mountTouch(root: HTMLElement): void {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.disposers.push(() => style.remove());

    const ui = document.createElement('div');
    ui.id = 'touch-ui';
    const zone = document.createElement('div');
    zone.id = 'touch-zone';
    const base = document.createElement('div');
    base.id = 'touch-joy-base';
    const knob = document.createElement('div');
    knob.id = 'touch-joy-knob';
    ui.append(zone, base, knob);

    const labels: Record<Flag, string> = { jab: 'JAB', cross: 'CRS', hook: 'HOK', uppercut: 'UPP', block: 'BLOCK' };
    for (const f of FLAGS) {
      const b = document.createElement('div');
      b.className = `touch-btn ${f}`;
      b.dataset['flag'] = f;
      b.textContent = labels[f];
      ui.appendChild(b);
      this.buttons.set(f, b);
      this.listen(b, 'pointerdown', (e: PointerEvent) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        this.touchFlags.add(f);
        b.classList.add('on');
      });
      const up = (e: PointerEvent) => {
        e.preventDefault();
        this.touchFlags.delete(f);
        b.classList.remove('on');
      };
      this.listen(b, 'pointerup', up);
      this.listen(b, 'pointercancel', up);
      this.listen(b, 'lostpointercapture', up);
    }

    // Floating joystick: base appears under the first finger on the left half.
    this.listen(zone, 'pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      if (this.joy) return;
      zone.setPointerCapture(e.pointerId);
      this.joy = { id: e.pointerId, bx: e.clientX, by: e.clientY, x: 0, y: 0 };
      ui.classList.add('joy-on');
      this.moveJoy(e.clientX, e.clientY);
    });
    this.listen(zone, 'pointermove', (e: PointerEvent) => {
      if (!this.joy || e.pointerId !== this.joy.id) return;
      e.preventDefault();
      this.moveJoy(e.clientX, e.clientY);
    });
    const joyUp = (e: PointerEvent) => {
      if (!this.joy || e.pointerId !== this.joy.id) return;
      e.preventDefault();
      this.joy = null;
      ui.classList.remove('joy-on');
    };
    this.listen(zone, 'pointerup', joyUp);
    this.listen(zone, 'pointercancel', joyUp);
    this.listen(zone, 'lostpointercapture', joyUp);
    this.listen(ui, 'contextmenu', (e: Event) => e.preventDefault());
    this.listen(ui, 'touchstart', (e: Event) => e.preventDefault(), { passive: false });

    root.appendChild(ui);
    this.ui = ui; this.joyBase = base; this.joyKnob = knob;
    this.disposers.push(() => ui.remove());
    this.listen(window, 'resize', () => { this.layoutKey = ''; });
  }

  private moveJoy(cx: number, cy: number): void {
    const j = this.joy;
    if (!j) return;
    const r = this.cfg.joyRadius;
    const dead = r * this.cfg.joyDeadZone;
    const dx = cx - j.bx, dy = cy - j.by;
    const dist = Math.hypot(dx, dy);
    let kx = j.bx, ky = j.by;
    if (dist > 0) {
      const clamped = Math.min(dist, r);
      const nx = dx / dist, ny = dy / dist;
      kx = j.bx + nx * clamped; ky = j.by + ny * clamped;
      const mag = clamped <= dead ? 0 : (clamped - dead) / (r - dead);
      j.x = nx * mag; j.y = ny * mag;
    } else {
      j.x = 0; j.y = 0;
    }
    if (this.joyBase) { this.joyBase.style.left = `${j.bx}px`; this.joyBase.style.top = `${j.by}px`; }
    if (this.joyKnob) { this.joyKnob.style.left = `${kx}px`; this.joyKnob.style.top = `${ky}px`; }
  }

  /** Position/size the touch controls from config; cheap key check each frame so sliders apply live. */
  private layoutTouch(): void {
    if (!this.ui) return;
    const c = this.cfg;
    const key = `${c.joyRadius}|${c.touchButtonR}|${c.touchButtonSep}|${c.touchBlockW}|${c.touchBlockH}|${c.touchMargin}|${innerWidth}|${innerHeight}`;
    if (key === this.layoutKey) return;
    this.layoutKey = key;

    const R = c.touchButtonR, sep = c.touchButtonSep, m = c.touchMargin;
    const gap = 14;
    const cx = innerWidth - (m + sep + R);
    const bcy = innerHeight - (m + c.touchBlockH / 2);
    const cy = bcy - c.touchBlockH / 2 - gap - sep - R;
    const at: Record<Flag, [number, number]> = {
      jab: [cx, cy - sep], cross: [cx + sep, cy], hook: [cx - sep, cy], uppercut: [cx, cy + sep], block: [cx, bcy],
    };
    for (const [f, el] of this.buttons) {
      const [x, y] = at[f];
      el.style.left = `${x}px`; el.style.top = `${y}px`;
      if (f === 'block') { el.style.width = `${c.touchBlockW}px`; el.style.height = `${c.touchBlockH}px`; }
      else { el.style.width = `${R * 2}px`; el.style.height = `${R * 2}px`; }
    }
    if (this.joyBase) { this.joyBase.style.width = `${c.joyRadius * 2}px`; this.joyBase.style.height = `${c.joyRadius * 2}px`; }
    if (this.joyKnob) { const k = c.joyRadius * 0.68; this.joyKnob.style.width = `${k}px`; this.joyKnob.style.height = `${k}px`; }
  }

  private listen<K extends keyof WindowEventMap>(t: Window, type: K, fn: (e: WindowEventMap[K]) => void, o?: AddEventListenerOptions): void;
  private listen<K extends keyof DocumentEventMap>(t: Document, type: K, fn: (e: DocumentEventMap[K]) => void, o?: AddEventListenerOptions): void;
  private listen<K extends keyof HTMLElementEventMap>(t: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions): void;
  private listen(t: EventTarget, type: string, fn: (e: never) => void, o?: AddEventListenerOptions): void {
    t.addEventListener(type, fn as EventListener, o);
    this.disposers.push(() => t.removeEventListener(type, fn as EventListener, o));
  }
}

/** Touch controls are wanted on a coarse-pointer device, or forced with `?touch=1` (`?touch=0` hides). */
export function wantsTouch(params: URLSearchParams): boolean {
  const p = params.get('touch');
  if (p === '1') return true;
  if (p === '0') return false;
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

declare global {
  interface Window {
    __input: {
      current: () => FrameInput;
      keys: () => string[];
      touch: { readonly joystick: { x: number; y: number } | null; readonly buttons: string[] };
    };
  }
}
