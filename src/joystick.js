/**
 * VirtualJoystick — on-screen draggable joystick for touch / mouse.
 *
 * Usage:
 *   const stick = new VirtualJoystick(scene, centerX, centerY, radius);
 *   // In update:
 *   const { x, y } = stick.getInput(); // each in [-1, 1]
 */
export class VirtualJoystick {
  constructor(scene, x, y, radius = 70) {
    this.scene  = scene;
    this.baseX  = x;
    this.baseY  = y;
    this.radius = radius;

    this.knobX  = x;
    this.knobY  = y;
    this.inputX = 0;
    this.inputY = 0;

    this.active          = false;
    this.activePointerId = -1;

    this.gfx = scene.add.graphics().setDepth(20);

    // Bind so we can un-register the same references later
    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp   = this._onUp.bind(this);

    scene.input.on('pointerdown',      this._onDown);
    scene.input.on('pointermove',      this._onMove);
    scene.input.on('pointerup',        this._onUp);
    scene.input.on('pointerupoutside', this._onUp);

    this._draw();
  }

  // ── Pointer event handlers ───────────────────────────────────────────────

  _onDown(pointer) {
    if (this.active) return;
    const dx = pointer.x - this.baseX;
    const dy = pointer.y - this.baseY;
    // Accept touches within 1.5× radius of the base (generous hit area)
    if (dx * dx + dy * dy <= (this.radius * 1.5) ** 2) {
      this.active          = true;
      this.activePointerId = pointer.id;
      this._updateKnob(pointer);
    }
  }

  _onMove(pointer) {
    if (!this.active || pointer.id !== this.activePointerId) return;
    this._updateKnob(pointer);
  }

  _onUp(pointer) {
    if (pointer.id !== this.activePointerId) return;
    this.active          = false;
    this.activePointerId = -1;
    this.knobX  = this.baseX;
    this.knobY  = this.baseY;
    this.inputX = 0;
    this.inputY = 0;
    this._draw();
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  _updateKnob(pointer) {
    const dx   = pointer.x - this.baseX;
    const dy   = pointer.y - this.baseY;
    const dist = Math.hypot(dx, dy);

    if (dist > 0) {
      const clamped = Math.min(dist, this.radius);
      const nx = dx / dist;
      const ny = dy / dist;
      this.knobX  = this.baseX + nx * clamped;
      this.knobY  = this.baseY + ny * clamped;
      this.inputX = nx * (clamped / this.radius);
      this.inputY = ny * (clamped / this.radius);
    } else {
      this.knobX  = this.baseX;
      this.knobY  = this.baseY;
      this.inputX = 0;
      this.inputY = 0;
    }
    this._draw();
  }

  _draw() {
    const g = this.gfx;
    g.clear();

    // Outer ring
    g.fillStyle(0x000000, 0.18);
    g.fillCircle(this.baseX, this.baseY, this.radius);
    g.lineStyle(3, 0xffffff, 0.28);
    g.strokeCircle(this.baseX, this.baseY, this.radius);

    // Knob
    const kr = this.radius * 0.34;
    g.fillStyle(0xffffff, this.active ? 0.55 : 0.18);
    g.fillCircle(this.knobX, this.knobY, kr);
    if (this.active) {
      g.lineStyle(2, 0xffffff, 0.45);
      g.strokeCircle(this.knobX, this.knobY, kr);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** @returns {{ x: number, y: number }} each axis -1..1 */
  getInput() {
    return { x: this.inputX, y: this.inputY };
  }

  destroy() {
    this.scene.input.off('pointerdown',      this._onDown);
    this.scene.input.off('pointermove',      this._onMove);
    this.scene.input.off('pointerup',        this._onUp);
    this.scene.input.off('pointerupoutside', this._onUp);
    this.gfx.destroy();
  }
}
