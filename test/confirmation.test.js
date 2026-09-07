import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONFIRMATION_PREFIX,
  EXPECTED_FIRST,
  MARKER,
  confirmationFailureMessage,
  hasConfirmation,
  inspectConfirmation
} from '../lib/confirmation.js';

const validDetail = CONFIRMATION_PREFIX + ' 新增了确认失败时的具体错误提示';
const validText = EXPECTED_FIRST + '\n' + validDetail;

test('接受符合两行格式的确认回应', () => {
  const inspection = inspectConfirmation(validText);
  assert.equal(inspection.ok, true);
  assert.equal(hasConfirmation(validText), true);
});

test('第一行不带末尾反斜杠同样有效', () => {
  const inspection = inspectConfirmation(MARKER + '\n' + validDetail);
  assert.equal(inspection.ok, true);
  assert.equal(inspection.issues.length, 0);
});

test('第一行 marker 与反斜杠之间允许空白', () => {
  assert.equal(hasConfirmation(MARKER + ' \\\n' + validDetail), true);
  assert.equal(hasConfirmation(MARKER + '   \\\n' + validDetail), true);
});

test('允许前置空行和确认后的后续说明', () => {
  const text = '\n' + validText + '\n继续原来的工作';
  assert.equal(hasConfirmation(text), true);
});

test('空回应视为尚未确认', () => {
  const inspection = inspectConfirmation('   ');
  assert.equal(inspection.ok, false);
  assert.equal(inspection.attempted, false);
});

test('第一行末尾多了一个反斜杠会被拒绝', () => {
  const text = MARKER + '\\\\\n' + validDetail;
  const inspection = inspectConfirmation(text);
  assert.equal(inspection.ok, false);
  assert.equal(inspection.issues.length, 1);
  assert.equal(inspection.issues[0].includes('第一行'), true);
  assert.equal(inspection.issues[0].includes(EXPECTED_FIRST), true);
});

test('指出确认标记没有出现在第一行, 并引用实际第一行', () => {
  const text = '好的我看到了\n' + validText;
  const inspection = inspectConfirmation(text);
  assert.equal(inspection.ok, false);
  assert.equal(inspection.issues.some((issue) => issue.includes('好的我看到了')), true);
});

test('指出第二行前缀不匹配, 并引用实际第二行', () => {
  const text = EXPECTED_FIRST + '\n我注意到 AGENTS 有变化';
  const inspection = inspectConfirmation(text);
  assert.equal(inspection.ok, false);
  assert.equal(inspection.issues.some((issue) => issue.includes('我注意到 AGENTS 有变化')), true);
});

test('指出第二行前缀后没有变化内容', () => {
  const text = EXPECTED_FIRST + '\n' + CONFIRMATION_PREFIX + '   ';
  const inspection = inspectConfirmation(text);
  assert.equal(inspection.ok, false);
  assert.equal(inspection.issues.length, 1);
  assert.equal(inspection.issues[0].includes('第二行'), true);
});

test('拒绝提示会带上当前应答的具体错误', () => {
  const text = MARKER + '\n随便说一句变化';
  const message = confirmationFailureMessage(text, 'turn');
  assert.equal(message.includes('第一行'), true);
  assert.equal(message.includes('随便说一句变化'), true);
  assert.equal(message.includes(EXPECTED_FIRST), true);
});
