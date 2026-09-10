import assert from 'node:assert/strict';
import test from 'node:test';

import { defaultCodexSelection, parseCodexModelListResponse, validateCodexSelection } from '../codex-models.mjs';
import { detectCodexDeepLink, isCodexThreadId } from '../codex-deep-link.mjs';

test('model/list order and supported reasoning order are preserved', () => {
  const models = parseCodexModelListResponse({ data: [
    { id: 'one', displayName: 'One', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
    { id: 'two', hidden: true, supportedReasoningEfforts: ['medium'] },
  ] });
  assert.deepEqual(models.map((model) => model.id), ['one', 'two']);
  assert.deepEqual(models[0].supportedReasoningEfforts, ['low', 'high']);
  assert.deepEqual(defaultCodexSelection(models), { model: 'one', reasoningEffort: 'low' });
});

test('selection rejects unavailable model without fallback and deep link requires validated thread id', async () => {
  const models = parseCodexModelListResponse({ data: [{ id: 'one', supportedReasoningEfforts: ['low'] }] });
  assert.throws(() => validateCodexSelection({ model: 'missing', reasoningEffort: 'low' }, models), /unavailable/u);
  assert.throws(() => validateCodexSelection({ model: 'one', reasoningEffort: 'high' }, models), /unsupported/u);
  assert.equal(isCodexThreadId('not-a-thread'), false);
  assert.equal(isCodexThreadId('123e4567-e89b-42d3-a456-426614174000'), true);
  assert.equal(await detectCodexDeepLink({ platform: 'linux' }), false);
});
