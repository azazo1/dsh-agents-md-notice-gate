import { describe, expect, test } from 'bun:test';
import { createUnifiedPatch, parseInstructionChange } from '../lib/index.js';

describe('AGENTS diff patch', () => {
  test('parses the current instruction content from an update notice', () => {
    const change = parseInstructionChange([
      'Updated instructions from: project/AGENTS.md',
      '',
      'This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.',
      '',
      'line one',
      'line two'
    ].join('\n'));

    expect(change).toEqual({ path: 'project/AGENTS.md', content: 'line one\nline two' });
  });

  test('creates an add patch when no previous content exists', () => {
    const patch = createUnifiedPatch('AGENTS.md', '', 'new rule');

    expect(patch).toContain('diff --git a/AGENTS.md b/AGENTS.md');
    expect(patch).toContain('+new rule');
    expect(patch).not.toContain('-new rule');
  });

  test('creates a replacement patch with removed and added lines', () => {
    const patch = createUnifiedPatch('AGENTS.md', 'old rule', 'new rule');

    expect(patch).toContain('-old rule');
    expect(patch).toContain('+new rule');
  });
});
