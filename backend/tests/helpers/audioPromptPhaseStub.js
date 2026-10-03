// The audio drain runs in phases (plan 2026-10-03): it writes pending prompts
// with the box's text model, then switches the box to each audio model. A
// test about the AUDIO side of the drain (breaker, packs, busy refunds, the
// job routes) spreads this into its dispatcher deps so that every prompt job
// "writes" at once without a model and no switch reaches a box. The phases
// themselves are tested, with recording fakes, in
// audio_two_phase_drain_db.test.js.
const promptPhaseStub = Object.freeze({
  switchModel: async () => ({ ok: true, json: {} }),
  loadTextProvider: async () => ({ id: null, modality: 'text', model: 'stub' }),
  writePrompt: async () => ({ ok: true }),
});

module.exports = { promptPhaseStub };
