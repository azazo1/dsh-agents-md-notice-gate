import { createTwoFilesPatch } from 'diff';
import { randomUUID } from 'node:crypto';

// AGENTS change notice gate host half — dsh-agents-md-notice-gate.
// When a workspace instruction (AGENTS.md / CLAUDE.md / AGENTS.local.md ...)
// changes, force the model to first emit a two-line confirmation
// [[ACK-AGENTS]]; until it does, every tool call is denied.
// Subsequent instruction messages are projected as diffs.

export const name = 'dsh-agents-md-notice-gate';

const INSTRUCTION_HEADINGS = /(?:^|\n)(Instructions from:|Additional instructions from:|Updated instructions from:|Instructions removed:) ([^\n]+)\n\n/g;

function blockText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function instructionSections(text) {
  if (typeof text !== 'string') return [];
  const sections = [];
  const matches = [...text.matchAll(INSTRUCTION_HEADINGS)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index + match[0].length;
    const nextHeading = matches[index + 1]?.index ?? -1;
    const reminderEnd = text.indexOf('</system-reminder>', start);
    const end = nextHeading >= 0 ? nextHeading : reminderEnd >= 0 ? reminderEnd : text.length;
    const rawContent = match[1] === 'Instructions removed:' ? '' : text.slice(start, end).trim();
    const content = match[1] === 'Updated instructions from:' || match[1] === 'Additional instructions from:'
      ? rawContent.slice(rawContent.indexOf('\n\n') + 2).trim()
      : rawContent;
    sections.push({
      path: match[2].trim(),
      action: match[1] === 'Instructions removed:' ? 'remove' : 'set',
      content
    });
  }
  return sections;
}

function unifiedDiff(previous, current, path) {
  if (previous === current) return '';
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, previous, current, '', '', { context: 3 });
}

function rememberSessionInstructions(session, snapshots) {
  const nodes = session?.surface?.nodes;
  if (!Array.isArray(nodes)) return;
  for (const seq of nodes) {
    const event = session.events?.[seq];
    if (event?.type !== 'user/message') continue;
    for (const section of instructionSections(blockText(event.data?.content))) {
      if (section.action === 'remove') snapshots.delete(section.path);
      else snapshots.set(section.path, section.content);
    }
  }
}

function projectInstructionDiff(message, snapshots) {
  const source = message?.source;
  if (!source || source.kind !== 'agent-instructions' || source.baseline === true || !Array.isArray(source.changes)) return message;
  const sections = instructionSections(blockText(message.content));
  if (sections.length === 0) return message;
  const changesByPath = new Map(source.changes.map((change) => [change.path, change]));

  const patches = [];
  for (const section of sections) {
    const change = changesByPath.get(section.path);
    const previous = snapshots.get(section.path) ?? '';
    const patch = unifiedDiff(previous, section.content, section.path);
    if (patch.length > 0) patches.push(patch);
    if (change?.action === 'remove' || section.action === 'remove') snapshots.delete(section.path);
    else snapshots.set(section.path, section.content);
  }
  if (patches.length === 0) return message;

  return {
    ...message,
    content: [{
      type: 'text',
      text: `<system-reminder>\n${patches.join('\n\n')}\n</system-reminder>`
    }]
  };
}

export function apply(ctx) {
  const MARKER = '[[ACK-AGENTS]]';
  const CONFIRMATION_PREFIX = '注意到 AGENTS 变化, 变化点在于:';
  const pending = new WeakMap();
  const snapshots = new WeakMap();
  const initialized = new WeakSet();
  const agents = new WeakMap();

  ctx.on('agent/created', ({ agent }) => {
    if (agent && agent.session) agents.set(agent.session, agent);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent && agent.session) {
      agents.delete(agent.session);
      snapshots.delete(agent.session);
      initialized.delete(agent.session);
    }
  });

  const hasConfirmation = (text) => {
    if (typeof text !== 'string') return false;
    const lines = text.trimStart().split(/\r?\n/);
    if (lines.length < 2 || lines[0].trim() !== `${MARKER}\\`) return false;
    const detail = lines[1].trim();
    return detail.startsWith(CONFIRMATION_PREFIX) && detail.slice(CONFIRMATION_PREFIX.length).trim().length > 0;
  };

  const markerAfter = (session, afterSeq) => {
    const nodes = session?.surface?.nodes;
    if (!Array.isArray(nodes)) return false;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const seq = nodes[index];
      const event = session.events?.[seq];
      if (event?.type !== 'assistant/message' || seq <= afterSeq) continue;
      if (hasConfirmation(blockText(event.data?.message?.content))) return true;
    }
    return false;
  };

  ctx.on('session/event', (session, event) => {
    if (!event?.data) return;
    if (event.type === 'user/message') {
      const text = blockText(event.data.content);
      const source = event.data.source;
      const isInstructionChange = source?.kind === 'agent-instructions' && source.baseline !== true && Array.isArray(source.changes);
      if (isInstructionChange || text.includes('Updated instructions from:') || text.includes('Additional instructions from:') || text.includes('Instructions removed:')) pending.set(session, event.seq);
    } else if (event.type === 'assistant/message' && hasConfirmation(blockText(event.data.message?.content))) {
      const seq = pending.get(session);
      if (seq !== undefined && event.seq > seq) pending.delete(session);
    }
  });

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    let sessionSnapshots = snapshots.get(agent.session);
    if (sessionSnapshots === undefined) {
      sessionSnapshots = new Map();
      snapshots.set(agent.session, sessionSnapshots);
    }
    if (!initialized.has(agent.session)) {
      rememberSessionInstructions(agent.session, sessionSnapshots);
      initialized.add(agent.session);
    }
    return {
      kind: 'enter',
      messages: decision.messages.map((message) => projectInstructionDiff(message, sessionSnapshots))
    };
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    const agent = exec?.agent;
    if (agent === undefined) return decision;
    const seq = pending.get(agent.session);
    if (seq === undefined) return decision;
    if (markerAfter(agent.session, seq)) {
      pending.delete(agent.session);
      return decision;
    }
    return { kind: 'deny', reason: 'AGENTS 变化尚未确认: 在继续调用工具之前, 请先查看指定 AGENTS.md 的变化, 并按两行格式回应. 第一行输出 ' + MARKER + '\\' + ', 第二行以 ' + CONFIRMATION_PREFIX + ' 开头并填写具体变化内容. 不能只输出 marker 或泛泛说明. 然后继续你原先的工作 (如果未结束).' };
  });

  ctx.on('agent/turn-stopping', ({ agent }) => {
    if (!pending.has(agent.session)) return;
    agent.steer({
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: 'AGENTS 变化尚未确认. 请先查看指定文件, 按两行格式回应: 第一行是 ' + MARKER + '\\' + ', 第二行以 ' + CONFIRMATION_PREFIX + ' 开头并填写具体变化内容.'
      }],
      source: { kind: 'plugin', plugin: name }
    });
  });

  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'dsh-agents-md-notice-gate',
      order: -50,
      text: [
        '本会话启用了 AGENTS 变化确认机制.',
        '当你收到 <system-reminder> 中以 "Updated instructions from:" 或 "Additional instructions from:" 或 "Instructions removed:" 等开头的消息 (表示某个 AGENTS.md / CLAUDE.md 等 workspace instructions 文件发生了变化) 时, 你必须先用两行回应确认变化. 第一行必须是 ' + MARKER + '\\' + ', 第二行必须以 ' + CONFIRMATION_PREFIX + ' 开头并填写具体变化内容.',
        '在你输出符合上述格式的回应之前, 所有工具调用和结束输出都会被阻止. 确认之后, 请继续你当前正在执行的任务并正常调用后续工具或结束输出.',
        '不要把确认回应与工具调用放在同一条消息中. 不能只输出 ' + MARKER + ', 也不能使用泛泛的确认语句.'
      ].join('\n')
    }));
  }
}
