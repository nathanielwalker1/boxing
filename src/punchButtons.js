import Phaser from 'phaser';

/**
 * PunchButtons — on-screen diamond punch UI + keyboard shortcuts.
 *
 * Diamond layout (bottom-right of screen):
 *
 *         HOOK [I]
 *   JAB [J]    CROSS [K]
 *       UPPERCUT [M]
 *
 * Keyboard: J = Jab, I = Hook, K = Cross, M = Uppercut
 *
 * onPunch callback receives punchType: 'jab' | 'hook' | 'cross' | 'uppercut'
 */
export class PunchButtons {
  constructor(scene, cx, cy, onPunch) {
    this.scene   = scene;
    this.onPunch = onPunch;

    const R   = 28;   // button radius
    const SEP = 60;   // center-to-center distance

    this._buttons = [
      { type: 'jab',      x: cx - SEP, y: cy,       label: 'JAB\n[J]' },
      { type: 'cross',    x: cx + SEP, y: cy,       label: 'CRS\n[K]' },
      { type: 'hook',     x: cx,       y: cy - SEP, label: 'HOK\n[I]' },
      { type: 'uppercut', x: cx,       y: cy + SEP, label: 'UPP\n[M]' },
    ];
    this._radius     = R;
    this._activeType = null;

    // Graphics layer for button shapes
    this.gfx = scene.add.graphics().setDepth(20);

    // Text labels inside buttons
    this._texts = this._buttons.map(btn =>
      scene.add.text(btn.x, btn.y, btn.label, {
        fontSize:   '9px',
        color:      '#ffffff',
        fontFamily: 'monospace',
        align:      'center',
      }).setOrigin(0.5, 0.5).setDepth(21)
    );

    // Keyboard shortcuts
    this._keys = scene.input.keyboard.addKeys({
      jab:      Phaser.Input.Keyboard.KeyCodes.J,
      cross:    Phaser.Input.Keyboard.KeyCodes.K,
      hook:     Phaser.Input.Keyboard.KeyCodes.I,
      uppercut: Phaser.Input.Keyboard.KeyCodes.M,
    });

    // Pointer: fire on touch/click inside a button
    this._onPointerDown = this._onPointerDown.bind(this);
    scene.input.on('pointerdown', this._onPointerDown);

    this._draw();
  }

  /**
   * Every Phaser object this component owns, for camera layer assignment
   * (Stage 11) — screen-anchored UI, ignored by the world camera.
   */
  displayObjects() {
    return [this.gfx, ...this._texts];
  }

  // ── Pointer handler ───────────────────────────────────────────────────────

  _onPointerDown(pointer) {
    for (const btn of this._buttons) {
      const dx = pointer.x - btn.x;
      const dy = pointer.y - btn.y;
      // Slightly generous hit area (1.3× radius) for easy tapping
      if (dx * dx + dy * dy <= (this._radius * 1.3) ** 2) {
        this._fire(btn.type);
        return;
      }
    }
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  _fire(type) {
    this.onPunch(type);
    this._flash(type);
  }

  _flash(type) {
    this._activeType = type;
    this._draw();
    // Clear active highlight after 120 ms
    this.scene.time.delayedCall(120, () => {
      if (this._activeType === type) {
        this._activeType = null;
        this._draw();
      }
    });
  }

  _draw() {
    const g = this.gfx;
    g.clear();

    for (const btn of this._buttons) {
      const active = btn.type === this._activeType;
      // Fill
      g.fillStyle(active ? 0xffffff : 0x2a2a55, active ? 0.85 : 0.65);
      g.fillCircle(btn.x, btn.y, this._radius);
      // Border
      g.lineStyle(2, active ? 0xffffff : 0x7777aa, active ? 1.0 : 0.55);
      g.strokeCircle(btn.x, btn.y, this._radius);
    }

    // Update text colors to contrast with active flash
    for (let i = 0; i < this._buttons.length; i++) {
      const active = this._buttons[i].type === this._activeType;
      this._texts[i].setColor(active ? '#1a1a2e' : '#ffffff');
    }
  }

  // ── Public: call every frame from scene.update() ──────────────────────────

  update() {
    if (Phaser.Input.Keyboard.JustDown(this._keys.jab))      this._fire('jab');
    if (Phaser.Input.Keyboard.JustDown(this._keys.hook))     this._fire('hook');
    if (Phaser.Input.Keyboard.JustDown(this._keys.cross))    this._fire('cross');
    if (Phaser.Input.Keyboard.JustDown(this._keys.uppercut)) this._fire('uppercut');
  }
}
