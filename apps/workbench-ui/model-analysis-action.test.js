import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('async function enhanceRecommendation('), app.indexOf('async function loadCore('));
function harness(response) {
  const calls = [], messages = [];
  const state = { providers: { apiEnabled: true, routes: [{ task: 'DECISION_SUPPORT', providerId: 'p', modelId: 'm' }], providers: [{ providerId: 'p', label: 'test', apiKeyConfigured: true }] }, liveRanking: { rows: [{ noteId: 'n' }] } };
  const context = { state, window: { confirm: () => true }, liveNoteFor: () => null, commentFragments: () => [], renderResearchWorkspace() {}, renderSharedRecommendation() {}, toast: (...args) => messages.push(args), api: async (...args) => { calls.push(args); return response; } };
  runInNewContext(source, context);
  return { ...context, calls, messages };
}
test('model action makes no request when disabled or unconfirmed', async () => {
  const h = harness({}); h.state.providers.apiEnabled = false;
  await h.enhanceRecommendation('n'); assert.equal(h.calls.length, 0);
  h.state.providers.apiEnabled = true; h.window.confirm = () => false;
  await h.enhanceRecommendation('n'); assert.equal(h.calls.length, 0);
});
test('valid model analysis is bound to the reference note and pending is cleared', async () => {
  const h = harness({ receipt: { status: 'SUCCEEDED', modelId: 'm', providerId: 'p' }, parsedJson: { recommendedAngle: 'angle', whyItWorks: 'evidence', executionSteps: ['step'], risks: ['missing metrics'] } });
  await h.enhanceRecommendation('n');
  assert.equal(h.calls.length, 1); assert.equal(h.state.modelInsight.noteId, 'n'); assert.equal(h.state.modelAnalysisPending, null);
});
test('malformed model output is rejected instead of displayed as a conclusion', async () => {
  const h = harness({ receipt: { status: 'SUCCEEDED' }, parsedJson: { recommendedAngle: 'bad', executionSteps: 'not an array' } });
  await h.enhanceRecommendation('n');
  assert.equal(h.state.modelInsight, undefined); assert.equal(h.state.modelAnalysisPending, null);
  assert.equal(h.messages.at(-1)[1], 'error');
});
test('pending analysis prevents duplicate requests', async () => {
  const h = harness({}); h.state.modelAnalysisPending = 'n';
  await h.enhanceRecommendation('n'); assert.equal(h.calls.length, 0);
});
