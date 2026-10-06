/**
 * Every similarity / scoring threshold in one place.
 *
 * Calibrated for the MiniLM cosine scale measured on this stack (smoke test 2026-10-06):
 *   paraphrase ≈ 0.70–0.95 · same-topic different wording ≈ 0.45–0.65 · unrelated ≈ −0.05–0.15
 * Other embedding models are mapped onto this scale by `Embedder.calibrate()`.
 * (TRD §6–§9 quote the design values; these are the calibrated numbers actually used.)
 */
export const T = {
  // triage / noise
  noiseSkip: 0.85,
  // stitcher
  stitchContinue: 0.45,
  // semantic repeat of a thought ("rehearsal" signal for promotion)
  repeat: 0.7,
  // memory echo: a past thought from ANOTHER session is related to the new one
  echo: 0.5,
  echoWithEntity: 0.4,
  // cross-session linking (consolidation)
  link: 0.45,
  // entity resolution
  entityMerge: 0.86,
  // pause intent (semantic backstop against pause exemplars)
  pauseSemantic: 0.72,
  // recall
  recallMin: 0.3,
  recallOpenAnswer: 0.5,
  // reference resolution
  refCandidateMin: 0.28,
  refAmbiguityMargin: 0.05,
  // recurring concern: embedding similarity between concern keys
  concernSame: 0.75,
  // repeated code/procedure pattern
  patternCluster: 0.65,
  // contradiction: same topic but different choice
  decisionTopic: 0.55,
} as const;

export const LIMITS = {
  /** abstention: below this an actionable artifact is downgraded to a tentative note */
  abstainConfidence: 0.55,
  /** autonomy L3 execution requires at least this confidence */
  autonomyConfidence: 0.8,
  /** delivery */
  deliveryThreshold: 0.5,
  quietMs: 1200,
  suggestionMinGapMs: 2 * 60_000,
  suggestionExpireMs: 10 * 60_000,
  echoExpireMs: 3 * 60_000,
  cooldownAfterDeliveryMs: 15 * 60_000,
  cooldownAfterDismissMs: 60 * 60_000,
  /** how many fragments of conversation context we hand to Wispr / the LLM */
  wisprConversation: 6,
  dictionaryTop: 150,
  recentFragmentsForContext: 6,
  /** a thread closes after this much silence (config overrides) */
  threadCloseMs: 6000,
  /** merge a fresh fragment into a thread closed less than this ago, if the LLM says "continue" */
  reopenWindowMs: 30_000,
} as const;
