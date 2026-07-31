import Phaser from 'phaser';

/**
 * BlockButton — held (not tapped) on-screen button + keyboard shortcut.
 *
 * Keyboard: Shift = Block
 *
 * Unlike PunchButtons, this fires no callback — the scene reads `.held`
 * (via update()) every frame, since block is a continuous state, not an event.
 */
export class BlockButton {
  constructor(scene, cx, cy) {
    this.scene = scene;
    this.cx    = cx;
    this.cy    = cy;
    this.w     = 120;
    this.h     = 44;

    this.held           = false;
    this._pointerActive = false;
    this._activePointerId = -1;

    this.gfx  = scene.add.graphics().setDepth(20);
    this.text = scene.add.text(cx, cy, 'BLOCK\n[Shift]', {
      fontSize:   '10px',
      color:      '#ffffff',
      fontFamily: 'monospace',
      align:      'center',
    }).setOrigin(0.5, 0.5).setDepth(21);

    this._key = scene.input.keyboard.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);

    this._onDown = this._onDown.bind(this);
    this._onUp   = this._onUp.bind(this);
    scene.input.on('pointerdown',      this._onDown);
    scene.input.on('pointerup',        this._onUp);
    scene.input.on('pointerupoutside', this._onUp);

    this._draw();
  }

  /**
   * Every Phaser object this component owns, for camera layer assignment
   * (Stage 11) — screen-anchored UI, ignored by the world camera.
   */
  displayObjects() {
    return [this.gfx, this.text];
  }

  // ── Pointer handlers ─────────────────────────────────────────────────────

  _hit(pointer) {
    return Math.abs(pointer.x - this.cx) <= this.w / 2 &&
           Math.abs(pointer.y - this.cy) <= this.h / 2;
  }

  _onDown(pointer) {
    if (this._pointerActive) return;
    if (this._hit(pointer)) {
      this._pointerActive   = true;
      this._activePointerId = pointer.id;
    }
  }

  _onUp(pointer) {
    if (pointer.id !== this._activePointerId) return;
    this._pointerActive   = false;
    this._activePointerId = -1;
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  _draw() {
    const g      = this.gfx;
    const active = this.held;
    g.clear();
    g.fillStyle(active ? 0xffffff : 0x552222, active ? 0.85 : 0.65);
    g.fillRoundedRect(this.cx - this.w / 2, this.cy - this.h / 2, this.w, this.h, 8);
    g.lineStyle(2, active ? 0xffffff : 0xaa7777, active ? 1.0 : 0.55);
    g.strokeRoundedRect(this.cx - this.w / 2, this.cy - this.h / 2, this.w, this.h, 8);
    this.text.setColor(active ? '#1a1a2e' : '#ffffff');
  }

  // ── Public: call every frame from scene.update() ──────────────────────────
  // @returns {boolean} whether block is currently held

  update() {
    const wasHeld = this.held;
    this.held = this._pointerActive || this._key.isDown;
    if (this.held !== wasHeld) this._draw();
    return this.held;
  }
}
