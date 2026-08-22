// AGENTS change notice gate host half — dsh-agents-md-notice-gate.
// When a workspace instruction (AGENTS.md / CLAUDE.md / AGENTS.local.md ...)
// changes, force the model to first emit a two-line confirmation
// [[ACK-AGENTS]]; until it does, every tool call is denied.

export const name = 'dsh-agents-md-notice-gate';

export function apply(ctx) {
  const MARKER = '[[ACK-AGENTS]]';
  const CONFIRMATION_PREFIX = '注意到 AGENTS 变化, 变化点在于:';
  const pending = new WeakMap();

  const blockText = (content) => {
    let out = '';
    if (!Array.isArray(content)) return out;
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') out += block.text;
    }
    return out;
  };

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

  ctx.on('session/event', (session, event) => {
    if (!event || !event.data) return;
    if (event.type === 'user/message') {
      const text = blockText(event.data.content);
      if (text.includes('Updated instructions from:') || text.includes('Additional instructions from:') || text.includes('Instructions removed:')) {
        pending.set(session, event.seq);
      }
    } else if (event.type === 'assistant/message') {
      const message = event.data && event.data.message;
      if (message && message.content && hasConfirmation(blockText(message.content))) {
        const seq = pending.get(session);
        if (seq !== undefined && event.seq > seq) pending.delete(session);
      }
    }
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    const agent = exec && exec.agent;
    if (agent === undefined) return decision;
    const session = agent.session;
    const seq = pending.get(session);
    if (seq === undefined) return decision;
    if (markerAfter(session, seq)) {
      pending.delete(session);
      return decision;
    }
    return { kind: 'deny', reason: 'AGENTS 变化尚未确认: 在继续调用工具之前, 请先查看指定 AGENTS.md 的变化, 并按两行格式回应. 第一行单独输出 ' + MARKER + ', 第二行以 ' + CONFIRMATION_PREFIX + ' 开头并填写具体变化内容. 不能只输出 marker 或泛泛说明.' };
  });

  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'dsh-agents-md-notice-gate',
      order: -50,
      text: [
        '本会话启用了 AGENTS 变化确认机制.',
        '当你收到 <system-reminder> 中以 "Updated instructions from:" 或 "Additional instructions from:" 或 "Instructions removed:" 等开头的消息 (表示某个 AGENTS.md / CLAUDE.md 等 workspace instructions 文件发生了变化) 时, 你必须先用两行回应确认变化. 第一行必须是 ' + MARKER + ', 第二行必须以 ' + CONFIRMATION_PREFIX + ' 开头并填写具体变化内容.',
        '在你输出符合上述格式的回应之前, 所有工具调用都会被拒绝. 确认之后, 请继续你当前正在执行的任务并正常调用后续工具.',
        '不要把确认回应与工具调用放在同一条消息中. 不能只输出 ' + MARKER + ', 也不能使用泛泛的确认语句.'
      ].join('\n')
    }));
  }
}
