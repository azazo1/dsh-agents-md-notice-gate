import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectSectionsIntoSnapshot,
  instructionSections,
  projectInstructionDiff,
  unifiedDiff,
} from '../lib/projection.js';

// A baseline workspace-instruction message: complete ASGENTS content with an
// `agent-instructions` source carrying `baseline: true` and a set change.
function baselineMessage(content, path, changes) {
  return {
    id: 'baseline-1',
    source: { kind: 'agent-instructions', form: 'instructions', baseline: true, changes },
    content: [{ type: 'text', text: `<system-reminder>\nInstructions from: ${path}\n\n${content}\n</system-reminder>` }],
  };
}

// A later change message for the same path (source.baseline is absent).
function changeMessage(content, path, changes) {
  return {
    id: 'change-1',
    source: { kind: 'agent-instructions', form: 'instructions', changes },
    content: [{ type: 'text', text: `\nUpdated instructions from: ${path}\n\nThis file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.\n\n${content}\n` }],
  };
}

test('当前 DSH Updated instructions 信封也能抽出文件正文并投影为 diff', () => {
  const snapshots = new Map();
  const baseContent = '# AGENTS\n\n旧规则: 直接在根目录工作\n';
  const changedContent = '# AGENTS\n\n新规则: 使用 just new <name> 创建子目录\n';
  const baseline = baselineMessage(baseContent, 'AGENTS.md', [{ action: 'set', scope: '.\0AGENTS.md', path: 'AGENTS.md', digest: 'a' }]);
  projectInstructionDiff(baseline, snapshots);

  const change = {
    id: 'change-dsh-current',
    source: { kind: 'agent-instructions', form: 'instructions', changes: [{ action: 'replace', scope: '.\0AGENTS.md', path: 'AGENTS.md', digest: 'b' }] },
    content: [{
      type: 'text',
      text: `<system-reminder>\nUpdated instructions from: AGENTS.md\n\nThis file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.\n\n${changedContent}</system-reminder>`,
    }],
  };
  const projected = projectInstructionDiff(change, snapshots);
  const diffText = projected.content[0].text;
  assert.equal(diffText.includes('<diff>'), true);
  assert.equal(diffText.includes('Updated instructions from:'), false);
  assert.equal(diffText.includes('+新规则: 使用 just new <name> 创建子目录'), true);
  assert.equal(diffText.includes('+旧规则: 直接在根目录工作'), false);
});

test('baseline 折叠进 snapshot 后, 第一次变化是增量 diff 而不是全量', () => {
  const snapshots = new Map();
  const baseContent = '规则1: 一些基准说明\n规则2: 另外一条说明\n规则3: 第三条说明\n';
  const changedContent = '规则1: 一些基准说明(修改后)\n规则2: 另外一条说明\n规则3: 第三条说明\n';

  const baseline = baselineMessage(baseContent, 'AGENTS.md', [{ action: 'set', scope: '.', path: 'AGENTS.md', digest: 'a' }]);
  const projectedBaseline = projectInstructionDiff(baseline, snapshots);
  // baseline 不上 diff, 原样返回; snapshot 保留文件正文, 包括空白.
  assert.equal(projectedBaseline, baseline);
  assert.equal(snapshots.get('AGENTS.md'), instructionSections(baseline.content[0].text)[0].content);

  const change = changeMessage(changedContent, 'AGENTS.md', [{ action: 'replace', scope: '.', path: 'AGENTS.md', digest: 'b' }]);
  const projectedChange = projectInstructionDiff(change, snapshots);
  const diffText = projectedChange.content[0].text;

  // 只改变了一行, diff 中不应出现"规则2/规则3"这类未改动行的完整文本作为新增.
  assert.equal(diffText.includes('<diff>'), true);
  // 变化行出现.
  assert.equal(diffText.includes('规则1: 一些基准说明(修改后)'), true);
  // 未变化的行不应在 diff 中被当作新增的全量文本 (仅作为 context 行出现, 前面带空格).
  assert.equal(diffText.includes('+规则2: 另外一条说明'), false);
  assert.equal(diffText.includes('+规则3: 第三条说明'), false);
  assert.equal(diffText.includes('+规则1: 一些基准说明(修改后)'), true);
  // 快照已更新.
  assert.equal(snapshots.get('AGENTS.md'), instructionSections(change.content[0].text)[0].content);
});

test('没有 baseline 快照时, 旧的空串"前状态"会导致全量 diff (记录旧行为)', () => {
  // 若 baseline 未被折叠, snapshot 里没有该 path, 第一次变化会以空串为前状态.
  const snapshots = new Map();
  const changedContent = '规则1: 一些基准说明(修改后)\n规则2: 另外一条说明\n规则3: 第三条说明\n';

  const change = changeMessage(changedContent, 'AGENTS.md', [{ action: 'replace', scope: '.', path: 'AGENTS.md', digest: 'b' }]);
  const projectedChange = projectInstructionDiff(change, snapshots);
  const diffText = projectedChange.content[0].text;

  // 旧 bug: 前状态为空, 因此全文都被当作新增 (每行前面带 '+').
  assert.equal(diffText.includes('+规则2: 另外一条说明'), true);
  assert.equal(diffText.includes('+规则3: 第三条说明'), true);
});

test('unifiedDiff 相同内容返回空串', () => {
  const x = 'abc\n';
  assert.equal(unifiedDiff(x, x, 'AGENTS.md'), '');
});

test('instructionSections 解析 baseline 的 Instructions from 区块', () => {
  const text = `<system-reminder>\nInstructions from: AGENTS.md\n\n规则1: 一些基准说明\n规则2: 另外一条说明\n</system-reminder>`;
  const sections = instructionSections(text);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].path, 'AGENTS.md');
  assert.equal(sections[0].content, '规则1: 一些基准说明\n规则2: 另外一条说明\n');
});

test('尾部换行不同也会投影为 diff, 而不是放行整文件', () => {
  const snapshots = new Map();
  const baseContent = '# AGENTS\n\n规则\n\n';
  const changedContent = '# AGENTS\n\n规则\n\n\n';
  const baseline = baselineMessage(baseContent, 'AGENTS.md', [{ action: 'set', path: 'AGENTS.md', digest: 'a' }]);
  projectInstructionDiff(baseline, snapshots);

  const change = {
    id: 'change-whitespace',
    source: { kind: 'agent-instructions', form: 'instructions', changes: [{ action: 'replace', path: 'AGENTS.md', digest: 'b' }] },
    content: [{
      type: 'text',
      text: `<system-reminder>\nUpdated instructions from: AGENTS.md\n\nThis file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.\n\n${changedContent}</system-reminder>`,
    }],
  };
  const projected = projectInstructionDiff(change, snapshots);
  const diffText = projected.content[0].text;
  assert.equal(diffText.includes('<diff>'), true);
  assert.equal(diffText.includes('Updated instructions from:'), false);
  assert.equal(diffText.includes('This file changed after it was loaded'), false);
  assert.notEqual(projected, change);
});

test('collectSectionsIntoSnapshot 折叠 set 与 remove', () => {
  const snapshots = new Map();
  const setText = 'Instructions from: AGENTS.md\n\n内容A\n';
  collectSectionsIntoSnapshot(setText, snapshots);
  assert.equal(snapshots.get('AGENTS.md'), '内容A\n');

  const removeText = 'Instructions removed: AGENTS.md\n\n...\n';
  collectSectionsIntoSnapshot(removeText, snapshots);
  assert.equal(snapshots.has('AGENTS.md'), false);
});
