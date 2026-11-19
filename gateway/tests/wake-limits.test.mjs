/** P6：wake limits / hint 契约。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WAKE_LIMITS,
  defaultWakeConfig,
  normalizeWakeConfig,
  validateWakeConfigInput,
  wakeConfigSummary,
} from '../social/wake.mjs';

test('默认 limits 与 DEFAULT_SOCIAL_CONFIG 一致，老配置读时补齐', () => {
  const plain = normalizeWakeConfig({});
  assert.deepEqual(plain.limits, { ...DEFAULT_WAKE_LIMITS });
  assert.equal(plain.hint, '');

  const agent = normalizeWakeConfig({ confirmedBy: 'agent' });
  assert.deepEqual(agent.limits, { ...DEFAULT_WAKE_LIMITS });

  const bad = normalizeWakeConfig({
    confirmedBy: 'agent',
    limits: {
      maxWakePerMinute: -3,
      maxWakePerHour: 'oops',
      preSleepWaitMs: Number.NaN,
      noActionLimit: '3',
      maxWakeConfigReminders: 99,
    },
    hint: `  ${'x'.repeat(220)}  `,
  });
  assert.equal(bad.limits.maxWakePerMinute, 1);
  assert.equal(bad.limits.maxWakePerHour, 12);
  assert.equal(bad.limits.preSleepWaitMs, 300000);
  assert.equal(bad.limits.noActionLimit, 3);
  assert.equal(bad.limits.maxWakeConfigReminders, 10);
  assert.equal(bad.hint.length, 200);
});

test('validateWakeConfigInput：limits 范围、未知子键、hint 长度与步进', () => {
  const base = defaultWakeConfig();
  const good = validateWakeConfigInput({
    limits: { maxWakePerHour: 20, preSleepWaitMs: 700000, maxWakeConfigReminders: 0 },
    hint: '可以在群里主动一点',
  }, base, { kind: 'group' });
  assert.equal(good.limits.maxWakePerHour, 20);
  assert.equal(good.limits.preSleepWaitMs, 700000);
  assert.equal(good.limits.maxWakeConfigReminders, 0);
  assert.equal(good.hint, '可以在群里主动一点');

  const assert400 = (config) => {
    try {
      validateWakeConfigInput(config, base, { kind: 'group' });
      assert.fail(`应当 400: ${JSON.stringify(config)}`);
    } catch (error) {
      assert.equal(error.status, 400);
      assert.equal(error.code, 'bad-request');
    }
  };

  assert400({ limits: { maxWakePerHour: 0 } });
  assert400({ limits: { foo: 1 } });
  assert400({ limits: { maxWakePerMinute: 1.5 } });
  assert400({ limits: { preSleepWaitMs: 300500 } });
  assert400({ hint: 'x'.repeat(201) });
  assert400({ hint: 123 });
});

test('wakeConfigSummary 带 limits 与管理员建议', () => {
  const cfg = normalizeWakeConfig({
    confirmedBy: 'agent',
    limits: {
      maxWakePerMinute: 2,
      maxWakePerHour: 30,
      preSleepWaitMs: 600000,
      noActionLimit: 5,
      maxWakeConfigReminders: 4,
    },
    hint: '主动一点',
  });
  const summary = wakeConfigSummary(cfg);
  assert.match(summary, /每分钟 2 次/);
  assert.match(summary, /每小时 30 次/);
  assert.match(summary, /沉睡前观察 600 秒/);
  assert.match(summary, /连续 5 轮无行动重置/);
  assert.match(summary, /管理员建议：主动一点/);
});
