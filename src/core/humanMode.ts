/**
 * core/humanMode.ts — the config overrides human mode (?human=1, cfg.humanBody) puts on top of the panel, in ONE place so
 * the game (main.ts, every frame) and the Node scripts (closeness probe, tests) fight under the same numbers.
 * Pure: config in, config out. No DOM, no three.js. Does nothing unless cfg.humanBody is on.
 *
 * NOT here (they need the browser): reading ?human=1, preloading the body file (which can turn humanBody back off), and
 * loading the mocap library (cfg.mocapGeo, then cfg.mocapOutcome). A Node caller sets humanBody / mocapGeo / mocapOutcome
 * itself after loading the library (scripts/lib/mocap_load.mjs), then calls this.
 */
import type { Config } from './config';

export function applyHumanMode(cfg: Config): void {
  if (!cfg.humanBody) return;
  cfg.punchTimeScale = cfg.humanPunchTimeScale; cfg.refEnabled = false; cfg.variantOverhand = !cfg.humanNoOverhand;
  cfg.evadeV2 = cfg.humanEvade; cfg.evadeFromBlock = cfg.humanEvadeFromBlock; cfg.evadeHeldTap = cfg.humanEvadeHeldTap; cfg.audioSlipOn = cfg.humanAudioSlip;
  cfg.aiHesitateScale = cfg.humanAiHesitate; cfg.aiStepInAfter = cfg.humanAiStepInAfter; cfg.aiHumanTempoEasy = cfg.humanAiTempoEasy; cfg.aiHumanTempoMed = cfg.humanAiTempoMed;
  cfg.staggerSpeedMax = cfg.humanStaggerSpeedMax; cfg.handNeutral = cfg.humanHandNeutral; cfg.contactSquash = cfg.humanContactSquash;
  cfg.punchChainAt = cfg.humanChainMiss; cfg.whiffRecoveryMult = cfg.humanWhiffRecovery; cfg.mocapTellChained = cfg.humanTellChained;
  cfg.iqMissCost = cfg.humanIqMissCost; cfg.iqScoring = cfg.humanIqScoring; cfg.iqLoadedCounter = cfg.humanIqLoadedCounter; cfg.iqLevelAtPress = cfg.humanIqLevelAtPress;
  cfg.bodyPowerScale = cfg.humanBodyPowerScale; cfg.aiBodyKeep = cfg.humanAiBodyKeep;
  cfg.comboStepMax = cfg.humanComboStepMax; cfg.comboCockScale = cfg.humanComboCock; cfg.comboHoldKeep = cfg.humanComboHoldKeep;
  if (cfg.humanStamina) {
    cfg.staminaLandRefund = cfg.humanStaminaLandRefund; cfg.staminaWhiffCost = cfg.humanStaminaWhiffCost; cfg.staminaWhiffDelay = cfg.humanStaminaWhiffDelay;
    cfg.staminaRegenDelay = cfg.humanStaminaRegenDelay; cfg.lowStaminaCockMult = cfg.humanLowStaminaCockMult; cfg.workCapLoss = cfg.humanWorkCapLoss;
    cfg.whiffCapLoss = cfg.humanWhiffCapLoss; cfg.staminaThrowScale = cfg.humanStaminaThrowScale; cfg.staminaRegen = cfg.humanStaminaRegen;
    cfg.staminaBusyRegen = cfg.humanStaminaBusyRegen; cfg.tiredPunchSlow = cfg.humanTiredPunchSlow;
  }
  if (cfg.humanNoSlowMo) { cfg.readWindowSlowMo = 1; cfg.readCounterSlowMoSeconds = 0; cfg.readRockedSlowMoSeconds = 0; cfg.showFinisherSlowMoSeconds = 0; }
}
