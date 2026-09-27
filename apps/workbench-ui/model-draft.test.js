import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
test('provider rendering restores unsaved address and key after mode changes', () => {
  const source = app.match(/function renderProviders\(\) \{[\s\S]*?\n\}\nfunction renderRoutes/)[0].replace(/\nfunction renderRoutes$/, '');
  const controls = Object.fromEntries(['baseUrl', 'apiKey', 'apiKeyEnv'].map(key => [key, { value: '', addEventListener(event, handler) { this[event] = handler; } }]));
  const card = { dataset: { provider: 'p' }, querySelector: selector => controls[selector.match(/data-field="(.+?)"/)?.[1]] };
  const catalog = { innerHTML: '', querySelector: () => null };
  const host = { innerHTML: '', querySelector: selector => selector === '[data-catalog]' ? catalog : card };
  const fields = { 'provider-cards': host, 'model-connection-status': {} };
  const drafts = new Map([['p', { baseUrl: 'https://custom.example/v1', apiKey: 'draft-only-test', apiKeyEnv: '' }]]);
  const context = { el: id => fields[id], providerDrafts: drafts, esc: String,
    state: { providers: { providers: [{ providerId: 'p', label: 'P', baseUrl: 'old', apiKeyEnv: '' }], routes: [], apiEnabled: true }, modelCatalogs: {} },
    document: { querySelector: () => ({ addEventListener() {} }) }, updateModelApiMode() {}, renderRoutes() {} };
  runInNewContext(source + '\nrenderProviders();', context);
  assert.equal(controls.baseUrl.value, 'https://custom.example/v1');
  assert.equal(controls.apiKey.value, 'draft-only-test');
  controls.baseUrl.value = 'https://changed.example/v1';
  controls.baseUrl.input();
  controls.baseUrl.value = '';
  context.renderProviders();
  assert.equal(controls.baseUrl.value, 'https://changed.example/v1');
  assert.equal(controls.apiKey.value, 'draft-only-test');
});
