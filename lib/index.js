// AGENTS change notice gate for DeepSeek Harness.
// When a workspace instruction (AGENTS.md / CLAUDE.md / AGENTS.local.md ...)
// changes, force the model to first emit a single-line confirmation
// [[ACK-AGENTS]]; until it does, every tool call is denied.
export default {
  name: 'dsh-agents-md-notice-gate',
  apply(ctx) {
    const MARKER = '[[ACK-AGENTS]]'
    const pending = new WeakMap()

    const blockText = (content) => {
      let out = ''
      if (!Array.isArray(content)) return out
      for (const block of content) {
        if (block && block.type === 'text' && typeof block.text === 'string') out += block.text
      }
      return out
    }

    const markerAfter = (session, afterSeq) => {
      const surface = session && session.surface
      const nodes = surface && Array.isArray(surface.nodes) ? surface.nodes : []
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const seq = nodes[i]
        const event = session.events && session.events[seq]
        if (event && event.type === 'assistant/message' && seq > afterSeq) {
          const message = event.data && event.data.message
          if (message && blockText(message.content).includes(MARKER)) return true
        }
      }
      return false
    }

    ctx.on('session/event', (session, event) => {
      if (!event || !event.data) return
      if (event.type === 'user/message') {
        const text = blockText(event.data.content)
        if (text.includes('Updated instructions from:') || text.includes('Additional instructions from:') || text.includes('Instructions removed:')) {
          pending.set(session, event.seq)
        }
      } else if (event.type === 'assistant/message') {
        const message = event.data && event.data.message
        if (message && message.content && blockText(message.content).includes(MARKER)) {
          const seq = pending.get(session)
          if (seq !== undefined && event.seq > seq) pending.delete(session)
        }
      }
    })

    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      const agent = exec && exec.agent
      if (agent === undefined) return decision
      const session = agent.session
      const seq = pending.get(session)
      if (seq === undefined) return decision
      if (markerAfter(session, seq)) {
        pending.delete(session)
        return decision
      }
      return { kind: 'deny', reason: 'AGENTS 变化尚未确认: 在继续调用工具之前, 请先单独输出确认标记 ' + MARKER + ' 一行, 作为你已注意到该变化的回应.' }
    })

    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      ctx.effect(() => systemPrompt.section({
        name: 'dsh-agents-md-notice-gate',
        order: -50,
        text: [
          '本会话启用了 AGENTS 变化确认机制.',
          '当你收到 <system-reminder> 中以 "Updated instructions from:" 或 "Additional instructions from:" 或 "Instructions removed:" 开头的消息 (表示某个 AGENTS.md / CLAUDE.md 等 workspace instructions 文件发生了变化) 时, 你必须先用一条单独的消息输出确认标记 ' + MARKER + ', 表示你已注意到该变化.',
          '在你输出 ' + MARKER + ' 之前, 所有工具调用都会被拒绝. 确认之后, 请用一句话向用户说明该变化的内容, 然后继续你当前正在执行的任务并正常调用后续工具.',
          '不要把 ' + MARKER + ' 混在普通说明文字里, 也不要把它与其他工具调用放在同一条消息中; 请让包含 ' + MARKER + ' 的回应先单独出现.'
        ].join('\n')
      }))
    }
  }
}
