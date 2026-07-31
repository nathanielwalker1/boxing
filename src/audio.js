/**
 * audio.js — combat SFX (Stage 10).
 *
 * The sounds are SYNTHESISED at runtime from the recipes in config.audioSounds
 * rather than loaded from files. That was a choice, not a constraint — the brief
 * allowed either — and it buys three things:
 *   • no licensing question to verify, and no binary blobs in the repo;
 *   • every characteristic of every hit (pitch, decay, filter, layer mix) is a
 *     number in config.js, so it obeys the project's "all tunables in one file"
 *     rule the same way punch damage does — a sourced .wav would be opaque;
 *   • it matches how the fighters themselves are built (procedural, no assets).
 *
 * The trade-off is fidelity: these are synthetic impacts, not recorded ones. If
 * they read as too "video-gamey" against real leather, swapping in sampled files
 * later means replacing playRecipe() — the call sites in _resolveAttack don't
 * change, because they only ever name a logical sound ('impactHeavy'), never a
 * source.
 *
 * NOTHING in here decides combat outcomes. It is called with an outcome that has
 * already been resolved, and its only job is to make a noise about it.
 */
import { config } from './config.js';

// ── Module state ─────────────────────────────────────────────────────────────
let ctx         = null;    // AudioContext (may be shared with Phaser's)
let noiseBuffer = null;    // one second of white noise, reused by every layer
let unavailable = false;   // set if WebAudio isn't there at all — stops retrying

/**
 * Bounded ring of recently-played sounds, for the Playwright checks: audio
 * output can't be asserted on headlessly, but "which logical sound did the
 * resolver ask for, at what pitch" can. Dev hook only — no gameplay reads it.
 */
export const audioLog = [];
const AUDIO_LOG_MAX = 50;

// ── Setup ────────────────────────────────────────────────────────────────────

/**
 * @param {AudioContext} [sharedCtx]  Phaser's own context, if it has one.
 *   Reusing it avoids a second AudioContext and inherits Phaser's unlock
 *   handling; we register our own unlock listeners regardless as a safety net.
 */
export function initCombatAudio(sharedCtx) {
  if (ctx || unavailable) return;
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    ctx = sharedCtx || (Ctor ? new Ctor() : null);
    if (!ctx) { unavailable = true; return; }

    noiseBufferFor(ctx);   // build and cache the shared white-noise source
    installUnlockHandlers();
  } catch (err) {
    // Never let an audio failure take the game down — it's feedback, not state.
    unavailable = true;
    ctx = null;
    console.warn('[audio] disabled — WebAudio unavailable:', err && err.message);
  }
}

/**
 * Autoplay policy: Chrome/Safari hand back a *suspended* context until the page
 * has seen a real user gesture. Resuming inside the gesture handler is the only
 * thing that works, so listen for the first one and then unhook. A rejected
 * resume() is swallowed deliberately — some environments (headless runs with no
 * gesture at all) simply never unlock, and that must stay silent rather than
 * logging an error on every punch.
 */
function installUnlockHandlers() {
  const unlock = () => {
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (!ctx || ctx.state === 'running') {
      for (const ev of ['pointerdown', 'touchstart', 'keydown']) {
        window.removeEventListener(ev, unlock);
      }
    }
  };
  for (const ev of ['pointerdown', 'touchstart', 'keydown']) {
    window.addEventListener(ev, unlock);
  }
}

// ── Playback ─────────────────────────────────────────────────────────────────

/**
 * Play one logical combat sound by manifest key.
 *
 * Each call gets its own random pitch and volume offset (config.audioPitchJitter
 * / audioVolumeJitter) so a four-jab burst doesn't sound like the same 100 ms of
 * audio stamped four times.
 *
 * @param {string} name  key into config.audioSounds ('impactSharp' | 'impactHeavy' | ...)
 */
export function playCombatSound(name) {
  const recipe = config.audioSounds[name];
  if (!recipe) return;

  // Jitter is logged even when the sound can't actually be heard, so the
  // Playwright checks can verify variance without a running audio device.
  const pitch = 1 + rand(config.audioPitchJitter);
  const gain  = Math.max(0, config.audioMasterVolume * (recipe.gain ?? 1) * (1 + rand(config.audioVolumeJitter)));
  logPlay(name, pitch, gain);

  if (!config.audioEnabled || gain <= 0) return;
  // Still locked by autoplay policy, or WebAudio missing. Dropping the sound is
  // correct — queueing them would dump a stack of stale impacts on first click.
  if (!ctx || ctx.state !== 'running') return;

  try {
    playRecipe(recipe, pitch, gain, ctx, ctx.destination);
  } catch (err) {
    console.warn('[audio] playback failed for', name, err && err.message);
  }
}

/**
 * Render a sound to an AudioBuffer through an OfflineAudioContext instead of the
 * speakers. Dev/verification only — scripts/audio_test.mjs uses it to measure
 * what the recipes actually produce (duration, level, spectral balance), which
 * is the only way to check the synthesis in a headless browser. It goes through
 * the SAME playRecipe() as live playback, so it can't drift from what you hear.
 *
 * @returns {Promise<AudioBuffer>|null}
 */
export function renderCombatSound(name, pitch = 1, seconds = 0.5) {
  const recipe = config.audioSounds[name];
  const Ctor   = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!recipe || !Ctor) return null;
  const rate  = 44100;
  const octx  = new Ctor(1, Math.ceil(rate * seconds), rate);
  playRecipe(recipe, pitch, recipe.gain ?? 1, octx, octx.destination);
  return octx.startRendering();
}

function rand(amount) {
  return (Math.random() * 2 - 1) * (amount || 0);
}

function logPlay(name, pitch, gain) {
  audioLog.push({ name, pitch: +pitch.toFixed(4), gain: +gain.toFixed(4), t: performance.now() });
  if (audioLog.length > AUDIO_LOG_MAX) audioLog.splice(0, audioLog.length - AUDIO_LOG_MAX);
}

/**
 * Build and fire the node graph for one recipe. Every layer is
 *   source → [filter] → gain → destination
 * with its own AD envelope, and all layers start on the same timestamp so the
 * transient stays tight. Nodes are one-shot: they disconnect themselves on end.
 *
 * Takes its context/destination as arguments purely so renderCombatSound() can
 * drive it into an OfflineAudioContext — live playback always passes the real
 * ones. Keeping it one function means the measured sound is the played sound.
 */
function playRecipe(recipe, pitch, masterGain, actx, dest) {
  const ctx = actx;
  const noise = noiseBufferFor(ctx);
  const t0 = ctx.currentTime;

  for (const layer of recipe.layers) {
    const attack = layer.attack ?? 0.001;
    const decay  = layer.decay  ?? 0.1;
    const peak   = Math.max(0.0001, (layer.gain ?? 1) * masterGain);

    // ── Source ─────────────────────────────────────────────────────────────
    let src;
    let startOffset = 0;
    if (layer.type === 'noise') {
      src = ctx.createBufferSource();
      src.buffer = noise;
      // Resampling the noise shifts its spectral centroid, which is what makes
      // the pitch jitter audible on the noise layers and not just the tones.
      src.playbackRate.value = pitch;
      // Random start offset so consecutive hits don't reuse the same samples.
      startOffset = Math.random() * 0.5;
    } else {
      src = ctx.createOscillator();
      src.type = layer.wave || 'sine';
      const f0 = (layer.freq ?? 200) * pitch;
      const f1 = (layer.freqEnd ?? layer.freq ?? 200) * pitch;
      src.frequency.setValueAtTime(f0, t0);
      if (f1 !== f0) src.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + attack + decay);
    }

    // ── Optional filter (with optional sweep — this is what makes the whiff) ─
    let node = src;
    if (layer.filter) {
      const biq = ctx.createBiquadFilter();
      biq.type    = layer.filter.type;
      biq.Q.value = layer.filter.q ?? 1;
      const c0 = layer.filter.freq * pitch;
      const c1 = (layer.filter.freqEnd ?? layer.filter.freq) * pitch;
      biq.frequency.setValueAtTime(clampFreq(c0, ctx.sampleRate), t0);
      if (c1 !== c0) biq.frequency.linearRampToValueAtTime(clampFreq(c1, ctx.sampleRate), t0 + attack + decay);
      src.connect(biq);
      node = biq;
    }

    // ── AD envelope ────────────────────────────────────────────────────────
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);

    node.connect(env);
    env.connect(dest);

    const stopAt = t0 + attack + decay + 0.02;
    if (layer.type === 'noise') src.start(t0, startOffset);
    else                        src.start(t0);
    src.stop(stopAt);
    src.onended = () => {
      try { src.disconnect(); node.disconnect(); env.disconnect(); } catch { /* already torn down */ }
    };
  }
}

function clampFreq(hz, sampleRate) {
  // Nyquist guard: pitch jitter on an already-high cutoff can otherwise push a
  // filter past the context's limit, which throws.
  return Math.min(Math.max(20, hz), sampleRate / 2 - 100);
}

/**
 * White-noise source buffer for a given context. The live context's is built
 * once at init and cached; an OfflineAudioContext used by renderCombatSound()
 * gets its own on demand (sample rates can differ, and init may not have run).
 */
function noiseBufferFor(actx) {
  if (actx === ctx && noiseBuffer) return noiseBuffer;
  const buf  = actx.createBuffer(1, actx.sampleRate, actx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  if (actx === ctx) noiseBuffer = buf;
  return buf;
}
