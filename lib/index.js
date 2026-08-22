import { randomUUID } from 'node:crypto';

const CHANGE_PREFIXES = [
  'Updated instructions from:',
  'Additional instructions from:',
  'Instructions removed:'
];
const PATCH_LIMIT = 128000;

function blockText(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((block) => block && block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('');
}

export function parseInstructionChange(text) {
  if (typeof text !== 'string') return undefined;
  const lines = text.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => CHANGE_PREFIXES.some((prefix) => line.startsWith(prefix)));
  if (headerIndex < 0) return undefined;
  const prefix = CHANGE_PREFIXES.find((item) => lines[headerIndex].startsWith(item));
  const path = lines[headerIndex].slice(prefix.length).trim();
  if (!path) return undefined;
  if (prefix === 'Instructions removed:') return { path, content: undefined };
  const bodyIndex = lines.findIndex((line, index) => index > headerIndex && line.trim() === '');
  const body = bodyIndex < 0 ? '' : lines.slice(bodyIndex + 1).join('\n');
  const separator = body.indexOf('\n\n');
  return { path, content: separator < 0 ? body : body.slice(separator + 2) };
}

function diffLines(oldContent, newContent) {
  const oldLines = oldContent === '' ? [] : oldContent.split('\n');
  const newLines = newContent === '' ? [] : newContent.split('\n');
  const rows = Array.from({ length: oldLines.length + 1 }, () => Array(newLines.length + 1).fill(0));
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      rows[oldIndex][newIndex] = oldLines[oldIndex] === newLines[newIndex] ? rows[oldIndex + 1][newIndex + 1] + 1 : Math.max(rows[oldIndex + 1][newIndex], rows[oldIndex][newIndex + 1]);
    }
  }
  const changes = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length || newIndex < newLines.length) {
    if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
      changes.push([' ', oldLines[oldIndex]]);
      oldIndex += 1;
      newIndex += 1;
    } else if (newIndex < newLines.length && (oldIndex === oldLines.length || rows[oldIndex][newIndex + 1] >= rows[oldIndex + 1][newIndex])) {
      changes.push(['+', newLines[newIndex]]);
      newIndex += 1;
    } else {
      changes.push(['-', oldLines[oldIndex]]);
      oldIndex += 1;
    }
  }
  return changes;
}

export function createUnifiedPatch(path, oldContent = '', newContent = '') {
  const changes = diffLines(oldContent, newContent);
  if (changes.length === 0 || changes.every(([kind]) => kind === ' ')) return '';
  const oldCount = oldContent === '' ? 0 : oldContent.split('\n').length;
  const newCount = newContent === '' ? 0 : newContent.split('\n').length;
  const patch = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...changes.map(([kind, line]) => `${kind}${line}`)
  ].join('\n');
  return patch.length > PATCH_LIMIT ? `${patch.slice(0, PATCH_LIMIT)}\n[patch truncated]` : patch;
}

// AGENTS change notice gate host half — dsh-agents-md-notice-gate.
// When a workspace instruction (AGENTS.md / CLAUDE.md / AGENTS.local.md ...)
// changes, force the model to first emit a two-line confirmation
// [[ACK-AGENTS]]; until it does, every tool call is denied.

export const name = 'dsh-agents-md-notice-gate';

export function apply(ctx) {
  const MARKER = '[[ACK-AGENTS]]';
  const CONFIRMATION_PREFIX = '注意到 AGENTS 变化, 变化点在于:';
  const pending = new WeakMap();
  const agents = new WeakMap();
  ctx.on('agent/created', ({ agent }) => {
    if (agent && agent.session) agents.set(agent.session, agent);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent && agent.session) agents.delete(agent.session);
  });

  const hasConfirmation = (text) => {
    if (typeof text !== 'string') return false;
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2 || lines[0].trim() !== MARKER) return false;
    const detail = lines[1].trim();
    return detail.startsWith(CONFIRMATION_PREFIX) && detail.slice(CONFIRMATION_PREFIX.length).trim().length > 0;
  };

  const markerAfter = (session, afterSeq) => {
    const surface = session && session.surface;
    const nodes = surface && Array.isArray(surface.nodes) ? surface.nodes : [];
    for (let i = nodes.length - 1; i >= 0; i -= 1) {
      const seq = nodes[i];
      const event = session.events && session.events[seq];
      if (event && event.type === 'assistant/message' && seq > afterSeq) {
        const message = event.data && event.data.message;
        if (message && hasConfirmation(blockText(message.content))) return true;
      }
    }
    return false;
  };

  const changePatch = (session, event, change) => {
    let previousContent = '';
    for (let index = event.seq - 1; index >= 0; index -= 1) {
      const prior = session.events && session.events[index];
      if (!prior || prior.type !== 'user/message') continue;
      const priorChange = parseInstructionChange(blockText(prior.data && prior.data.content));
      if (priorChange && priorChange.path === change.path) {
        previousContent = priorChange.content ?? '';
        break;
      }
    }
    return createUnifiedPatch(change.path, previousContent, change.content ?? '');
  };

  ctx.on('session/event', (session, event) => {
    if (!event || !event.data) return;
    if (event.type === 'user/message') {
      const text = blockText(event.data.content);
      const change = parseInstructionChange(text);
      if (change) {
        const patch = changePatch(session, event, change);
        pending.set(session, { seq: event.seq, patch });
        const agent = ctx.agents?.get(session.id) ?? agents.get(session) ?? ctx.agent ?? ctx.agents?.currentInitiator?.();
        if (patch && agent && agent.session === session) {
          agent.inject({
            id: randomUUID(),
            role: 'user',
            content: [{
              type: 'text',
              text: 'AGENTS 变化的 diff patch:\n\n' + patch
            }],
            source: { kind: 'plugin', plugin: name }
          });
        }
      }
    } else if (event.type === 'assistant/message') {
      const message = event.data && event.data.message;
      if (message && message.content && hasConfirmation(blockText(message.content))) {
        const state = pending.get(session);
        if (state !== undefined && event.seq > state.seq) pending.delete(session);
      }
    }
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    const agent = exec && exec.agent;
    if (agent === undefined) return decision;
    const session = agent.session;
    const state = pending.get(session);
    if (state === undefined) return decision;
    if (markerAfter(session, state.seq)) {
      pending.delete(session);
      return decision;
    }
    return { kind: 'deny', reason: 'AGENTS 变化尚未确认: 在继续调用工具之前, 请先查看指定 AGENTS.md 的变化, 并按两行格式回应. 第一行单独输出 ' + MARKER + ', 第二行以 ' + CONFIRMATION_PREFIX + ' 开头并填写具体变化内容. 不能只输出 marker 或泛泛说明. 然后继续你原先的工作 (如果未结束).' };
  });

  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (pending.has(agent.session)) {
      agent.steer({
        id: randomUUID(),
        role: 'user',
        content: [{
          type: 'text',
          text: 'AGENTS 变化尚未确认. 请先查看指定文件, 按两行格式回应: 第一行是 ' + MARKER + ', 第二行以 ' + CONFIRMATION_PREFIX + ' 开头并填写具体变化内容.'
        }],
        source: { kind: 'plugin', plugin: name }
      });
    }
  });

  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'dsh-agents-md-notice-gate',
      order: -50,
      text: [
        '本会话启用了 AGENTS 变化确认机制.',
        '当你收到 <system-reminder> 中以 "Updated instructions from:" 或 "Additional instructions from:" 或 "Instructions removed:" 等开头的消息 (表示某个 AGENTS.md / CLAUDE.md 等 workspace instructions 文件发生了变化) 时, 你必须先用两行回应确认变化. 第一行必须是 ' + MARKER + ', 第二行必须以 ' + CONFIRMATION_PREFIX + ' 开头并填写具体变化内容.',
        '在你输出符合上述格式的回应之前, 所有工具调用和结束输出都会被阻止. 确认之后, 请继续你当前正在执行的任务并正常调用后续工具或结束输出.',
        '不要把确认回应与工具调用放在同一条消息中. 不能只输出 ' + MARKER + ', 也不能使用泛泛的确认语句.'
      ].join('\n')
    }));
  }
}
