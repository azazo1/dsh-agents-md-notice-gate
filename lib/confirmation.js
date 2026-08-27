export const MARKER = '[[ACK-AGENTS]]';
export const CONFIRMATION_PREFIX = '注意到 AGENTS 变化, 变化点在于:';
export const EXPECTED_FIRST = MARKER + '\\';

function previewLine(line) {
  const value = String(line).replace(/\s+/g, ' ').trim();
  if (value.length === 0) return '(空行)';
  return value.length <= 120 ? value : value.slice(0, 120) + '...';
}

export function inspectConfirmation(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, attempted: false, issues: ['当前还没有确认回应.'] };
  }

  const lines = text.trimStart().split(/\r?\n/);
  const firstTrimmed = (lines[0] ?? '').trim();
  const issues = [];

  if (firstTrimmed !== EXPECTED_FIRST) {
    const laterHasMarker = lines.slice(1).some((line) => line.includes(MARKER));
    if (firstTrimmed === MARKER) {
      issues.push('第一行是 ' + MARKER + ', 缺少末尾的 `\\`. 正确第一行是 ' + EXPECTED_FIRST + '.');
    } else if (firstTrimmed === MARKER + '\\\\') {
      issues.push('第一行末尾多了一个 `\\`. 正确第一行是 ' + EXPECTED_FIRST + '.');
    } else if (firstTrimmed.startsWith(EXPECTED_FIRST)) {
      issues.push('第一行确认标记后面还有多余内容, 标记必须独占一行. 实际第一行: "' + previewLine(firstTrimmed) + '".');
    } else if (firstTrimmed.startsWith(MARKER) && /^\s+\\/.test(firstTrimmed.slice(MARKER.length))) {
      issues.push('第一行 marker 与 `\\` 之间有多余空格. 正确第一行是 ' + EXPECTED_FIRST + '.');
    } else if (firstTrimmed.startsWith(MARKER) && firstTrimmed.length === MARKER.length + 1) {
      issues.push('第一行末尾不是半角反斜杠 `\\`. 正确第一行是 ' + EXPECTED_FIRST + ', 实际是: "' + previewLine(firstTrimmed) + '".');
    } else if (firstTrimmed.startsWith(MARKER) && firstTrimmed.includes(CONFIRMATION_PREFIX)) {
      issues.push('确认标记和第二行说明写在同一行了, 必须分成两行. 实际第一行: "' + previewLine(firstTrimmed) + '".');
    } else if (firstTrimmed.startsWith(MARKER)) {
      issues.push('第一行确认标记格式不对. 应为 ' + EXPECTED_FIRST + ', 实际是: "' + previewLine(firstTrimmed) + '".');
    } else if (laterHasMarker || firstTrimmed.includes(MARKER)) {
      issues.push('确认标记没有出现在第一行. 实际第一行: "' + previewLine(firstTrimmed) + '".');
    } else {
      issues.push('第一行不是确认标记 ' + EXPECTED_FIRST + '. 实际第一行: "' + previewLine(firstTrimmed) + '".');
    }
  }

  if (lines.length < 2) {
    issues.push('缺少第二行变化说明. 第二行必须以 ' + CONFIRMATION_PREFIX + ' 开头, 并填写具体变化内容.');
  } else {
    const detail = lines[1].trim();
    if (detail.length === 0) {
      issues.push('第二行是空行. 第二行必须以 ' + CONFIRMATION_PREFIX + ' 开头, 并填写具体变化内容.');
    } else if (!detail.startsWith(CONFIRMATION_PREFIX)) {
      issues.push('第二行没有以 ' + CONFIRMATION_PREFIX + ' 开头. 实际第二行: "' + previewLine(detail) + '".');
    } else if (detail.slice(CONFIRMATION_PREFIX.length).trim().length === 0) {
      issues.push('第二行前缀后面没有填写具体变化内容.');
    }
  }

  return issues.length === 0
    ? { ok: true, attempted: true, issues: [] }
    : { ok: false, attempted: true, issues };
}

export function hasConfirmation(text) {
  return inspectConfirmation(text).ok;
}

export function confirmationFailureMessage(text, kind) {
  const inspection = inspectConfirmation(text);
  const header = inspection.attempted
    ? 'AGENTS 变化确认格式不正确:'
    : 'AGENTS 变化尚未确认:';
  const hint = kind === 'tools'
    ? '在继续调用工具之前, 请先查看指定 AGENTS.md 的变化, 并按两行格式重新回应. 第一行输出 ' + EXPECTED_FIRST + ', 第二行以 ' + CONFIRMATION_PREFIX + ' 开头并填写具体变化内容. 注意第一行的 `\\` 为格式需求不能少. 不能只输出 marker 或泛泛说明. 然后继续你原先的工作 (如果未结束).'
    : '请先查看指定文件, 按两行格式重新回应: 第一行是 ' + EXPECTED_FIRST + ', 第二行以 ' + CONFIRMATION_PREFIX + ' 开头并填写具体变化内容, 注意第一行的 `\\` 为格式需求不能少.';
  return [header, ...inspection.issues.map((issue) => '- ' + issue), hint].join('\n');
}
