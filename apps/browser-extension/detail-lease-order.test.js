import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('search completion cannot speculatively open an unleased enrichment target', () => {
  const source = readFileSync(new URL('./content-script.js', import.meta.url), 'utf8');
  const start = source.indexOf('if (task.expectedPageType === "SEARCH" && task.context?.autoCollectNotes === true)');
  const block = source.slice(start, source.indexOf('scheduleDrive(task.context?.requestIntervalMs', start));
  assert.ok(start > 0);
  assert.ok(block.indexOf('await send({ kind: "LEASE_BROWSER_TASK" })') < block.indexOf('await openTargetCard(nextDecision)'));
  assert.doesNotMatch(block, /preferredTarget|openedFromAcceptedSnapshot/);
  assert.match(block, /nextDecision.action === "OPEN_SEARCH_CARD"/);
});
