import { createTwoFilesPatch } from 'diff';
import { randomUUID } from 'node:crypto';
import {
  CONFIRMATION_PREFIX,
  confirmationFailureMessage,
  hasConfirmation,
  MARKER
} from './confirmation.js';

// AGENTS change notice gate host half — dsh-agents-md-notice-gate.
// When a workspace instruction (AGENTS.md / CLAUDE.md / AGENTS.local.md ...)
// changes, force the model to first emit a two-line confirmation
// [[ACK-AGENTS]]; until it does, every tool call is denied.
// Subsequent instruction messages are projected as diffs.

export const name = 'dsh-agents-md-notice-gate';

const INSTRUCTION_HEADINGS = /(?:^|\n)(Instructions from:|Additional instructions from:|Updated instructions from:|Instructions removed:) ([^\n]+)\n\n/g;
const CHANGE_CONFIRMATION_NOTICE = '需要你按照规定输出 ' + MARKER + ' 和相关说明以继续工作.';

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
      text: `<system-reminder>\n<diff>${patches.join('\n\n')}</diff>\n${CHANGE_CONFIRMATION_NOTICE}\n</system-reminder>`
    }]
  };
}

export function apply(ctx) {
  const pending = new WeakMap();
  const recovered = new WeakMap();
  const snapshots = new WeakMap();
  const initialized = new WeakSet();
  const agents = new WeakMap();

  ctx.on('agent/created', ({ agent }) => {
    if (agent && agent.session) agents.set(agent.session, agent);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent && agent.session) {
      agents.delete(agent.session);
      recovered.delete(agent.session);
      snapshots.delete(agent.session);
      initialized.delete(agent.session);
    }
  });

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

  const latestAssistantText = (session) => {
    const nodes = session?.surface?.nodes;
    if (!Array.isArray(nodes)) return '';
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const event = session.events?.[nodes[index]];
      if (event?.type === 'assistant/message') return blockText(event.data?.message?.content);
    }
    return '';
  };

  const hasEarlierAssistant = (session) => {
    const nodes = session?.surface?.nodes;
    if (!Array.isArray(nodes)) return false;
    let foundLatest = false;
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const event = session.events?.[nodes[index]];
      if (event?.type !== 'assistant/message') continue;
      if (!foundLatest) {
        foundLatest = true;
        continue;
      }
      return true;
    }
    return false;
  };

  const steerContinuation = (agent, text) => {
    agent.steer({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: name }
    });
  };

  ctx.on('session/event', (session, event) => {
    if (!event?.data) return;
    if (event.type === 'user/message') {
      const text = blockText(event.data.content);
      const source = event.data.source;
      const isInstructionChange = source?.kind === 'agent-instructions' && source.baseline !== true && Array.isArray(source.changes);
      if (isInstructionChange || text.includes('Updated instructions from:') || text.includes('Additional instructions from:') || text.includes('Instructions removed:')) pending.set(session, event.seq);
         recovered.delete(session);
    } else if (event.type === 'assistant/message' && hasConfirmation(blockText(event.data.message?.content))) {
      const seq = pending.get(session);
      if (seq !== undefined && event.seq > seq) pending.delete(session);
         recovered.set(session, { confirmationSeq: event.seq, replacedEarlierOutput: hasEarlierAssistant(session) });
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
    return { kind: 'deny', reason: confirmationFailureMessage(latestAssistantText(agent.session), 'tools') };
  });

  ctx.on('agent/turn-stopping', ({ agent }) => {
    const finalText = latestAssistantText(agent.session);
    if (hasConfirmation(finalText)) {
      pending.delete(agent.session);
      steerContinuation(agent, '不要在确认回应之后中断本轮工作, 如果还有工作请继续, 如果已经结束, 请简单输出结束语.');
      return;
    }
    if (!pending.has(agent.session)) return;
    steerContinuation(agent, confirmationFailureMessage(finalText, 'turn'));
  });

  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'dsh-agents-md-notice-gate',
      order: -50,
      text: [
        '本会话启用了 AGENTS 变化确认机制.',
        '当你收到 AGENTS.md 这类文件发生变化的通知 (通常是一个 diff patch) 时, 你必须先用两行回应确认变化. 首次创建 session 时注入的 AGENTS.md 内容不属于变化确认, 不需要输出 marker. 第一行必须是 ' + MARKER + '\\' + ', 第二行必须以 ' + CONFIRMATION_PREFIX + ' 开头并填写具体变化内容, 注意第一行的 `\\` 为格式需求不能少.',
        '变化说明应简要描述新增或修改的内容. 已删除的内容不需要遵守.',
        '确认回应尽量单独成条输出: 这一条消息只放上述两行, 不要夹带工具调用, 分隔线, 过程说明或最终回答.',
        '在你输出符合上述格式的独立确认回应之前, 所有工具调用和结束输出都会被阻止. 不能只输出 ' + MARKER + ', 也不能使用泛泛的确认语句.',
        '不要把确认回应与其它内容混在同一条消息里. 例如不要先 ack 再在同一条消息中调用工具并给出最终输出, 不要 ack 后用分隔线接上最终输出, 也不要把 ack 直接写进最终输出.',
        '确认之后, 另开后续消息继续当前任务并正常调用工具. 确认回应不能结束本轮, 但后续工作必须写在确认消息之后, 不要塞进确认消息本身. 最终完成后再结束本轮.'
      ].join('\n')
    }));
  }
}
