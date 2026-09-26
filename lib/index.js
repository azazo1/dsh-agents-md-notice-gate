import { randomUUID } from 'node:crypto';
import {
  blockText,
  collectSectionsIntoSnapshot,
  latestAssistantText,
  markerAfter,
  projectInstructionDiff,
  rememberSessionInstructions
} from './projection.js';
import {
  CONFIRMATION_PREFIX,
  EXPECTED_FIRST,
  MARKER,
  REQUEST_MARKER,
  confirmationFailureMessage,
  hasConfirmation,
} from './confirmation.js';

// AGENTS change notice gate host half — dsh-agents-md-notice-gate.
// When a workspace instruction (AGENTS.md / CLAUDE.md / AGENTS.local.md ...)
// changes, the model sees [[REQ-AGENTS]] and must first emit a two-line
// [[ACK-AGENTS]] confirmation. Until it does, every tool call is denied.
// Subsequent instruction messages are projected as diffs. The pre-step
// listener must be prepended so it rewrites AFTER dsh-agent-instructions
// injects the full-file update into the enter batch.

export const name = 'dsh-agents-md-notice-gate';

// 确认回应不能结束本轮: 有效确认之后如果模型想停下, 用它把工作接回去.
const CONTINUE_AFTER_ACK = '不要在确认回应之后中断本轮工作, 如果还有工作请继续, 如果已经结束, 请简单输出结束语.';

// 没有待确认变化 (pending 里没有该 session) 时, 模型自行输出的 marker 一律忽略:
// 它不构成确认, 不解除任何状态, 也不会触发追问或接续本轮.
export function apply(ctx) {
  const pending = new WeakMap();
  const acknowledged = new WeakSet();
  const snapshots = new WeakMap();
  const initialized = new WeakSet();
  const agents = new WeakMap();

  ctx.on('agent/created', ({ agent }) => {
    if (agent && agent.session) agents.set(agent.session, agent);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent && agent.session) {
      agents.delete(agent.session);
      acknowledged.delete(agent.session);
      snapshots.delete(agent.session);
      initialized.delete(agent.session);
    }
  });

  const steerContinuation = (agent, text) => {
    agent.steer({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: name }
    });
  };

  ctx.on('session/event', (session, event) => {
    if (!event?.data) return;
    if (event.type === 'user/message') {
      const text = blockText(event.data.content);
      const source = event.data.source;
      const isInstructionChange = source?.kind === 'agent-instructions' && source.baseline !== true && Array.isArray(source.changes);
      // Folding a baseline into the snapshot here means the first later change is
      // a true delta; otherwise the baseline stays unrecorded and the first
      // change diff is rendered against an empty "before" (a full-file diff).
      if (source?.kind === 'agent-instructions' && source.baseline === true) {
        let sessionSnapshots = snapshots.get(session);
        if (sessionSnapshots === undefined) {
          sessionSnapshots = new Map();
          snapshots.set(session, sessionSnapshots);
        }
        collectSectionsIntoSnapshot(text, sessionSnapshots);
      }
      // 只认 agent-instructions 的非 baseline 事件. 引用会话, 用户原话,
      // runtime-context 里即使出现 Updated instructions from: 也不算变化.
      if (isInstructionChange) {
        pending.set(session, event.seq);
        acknowledged.delete(session);
      }
    } else if (event.type === 'assistant/message') {
      const seq = pending.get(session);
      // 没有待确认变化, 或变化发生在更晚的位置: 这条 marker 不属于确认, 直接忽视.
      if (seq === undefined || event.seq <= seq) return;
      if (hasConfirmation(blockText(event.data.message?.content))) {
        pending.delete(session);
        acknowledged.add(session);
      }
    }
  });

  // Must prepend: dsh-agent-instructions injects AGENTS.md updates into the
  // enter batch AFTER calling next(). An inner listener would rewrite claimed
  // messages first, then the injector would splice the original full file back
  // in, which is exactly the "no diff, original content" failure.
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
      ...decision,
      messages: decision.messages.map((message) => projectInstructionDiff(message, sessionSnapshots))
    };
  }, { prepend: true });

  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    const agent = exec?.agent;
    if (agent === undefined) return decision;
    const seq = pending.get(agent.session);
    if (seq === undefined) return decision;
    if (markerAfter(agent.session, seq)) {
      pending.delete(agent.session);
      acknowledged.add(agent.session);
      return decision;
    }
    return { kind: 'deny', reason: confirmationFailureMessage(latestAssistantText(agent.session), 'tools') };
  });

  ctx.on('agent/turn-stopping', ({ agent }) => {
    const session = agent.session;
    const finalText = latestAssistantText(session);
    if (pending.has(session)) {
      if (hasConfirmation(finalText)) {
        // 兜底: assistant/message 事件还没折叠这次确认.
        pending.delete(session);
        steerContinuation(agent, CONTINUE_AFTER_ACK);
        return;
      }
      steerContinuation(agent, confirmationFailureMessage(finalText, 'turn'));
      return;
    }
    // 本轮结束时的 marker 只有在它真的确认过一次变化时才需要跟进;
    // 否则 (比如模型自己主动输出 marker) 完全忽视.
    if (!acknowledged.delete(session)) return;
    if (hasConfirmation(finalText)) steerContinuation(agent, CONTINUE_AFTER_ACK);
  });

  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt !== undefined) {
    ctx.effect(() => systemPrompt.section({
      name: 'dsh-agents-md-notice-gate',
      order: -50,
      text: [
        '当 AGENTS.md 发生变化, 你会收到一条 diff 通知, 其中 <path> 是变化文件的路径, 末尾是 ' + REQUEST_MARKER + '. 收到它时你需要进行确认',
        '先单独回复下面两行, 不要夹带工具调用或其它文字. 第一行是确认标记, 第二行写出具体变化; 文件被删除就写已删除, 并停止遵守已删除内容:',
        EXPECTED_FIRST,
        CONFIRMATION_PREFIX + ' <具体变化>',
        '在你发出这条确认之前, 工具调用和结束本轮都会被阻止. 输出确认的同时不要停止工具调用, 继续原先的工作. 注意仅在有 ' + REQUEST_MARKER + ' 的时候进行确认.'
      ].join('\n')
    }));
  }
}
