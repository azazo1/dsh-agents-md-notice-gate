import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../lib/index.js';
import { CONFIRMATION_PREFIX, EXPECTED_FIRST } from '../lib/confirmation.js';

// 一个最小的 host 侧 harness: 只保留本插件真正用到的事件面.
function createHarness() {
  const handlers = new Map();
  apply({
    on(event, handler) { handlers.set(event, handler); },
    get() { return undefined; },
    effect(fn) { fn(); }
  });

  const events = [];
  const session = {
    surface: { nodes: [] },
    eventAt(seq) { return events[seq]; }
  };
  const steers = [];
  const agent = {
    session,
    steer(message) { steers.push(message.content[0].text); }
  };

  const emit = (event) => {
    const seq = events.length;
    const stamped = { ...event, seq };
    events.push(stamped);
    session.surface.nodes.push(seq);
    handlers.get('session/event')(session, stamped);
  };

  const acknowledgment = EXPECTED_FIRST + '\n' + CONFIRMATION_PREFIX + ' 新增了一条规则';

  return {
    steers,
    acknowledgment,
    assistant(text) {
      emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
    },
    instructionChange(text) {
      emit({
        type: 'user/message',
        data: {
          content: [{ type: 'text', text }],
          source: { kind: 'agent-instructions', form: 'instructions', changes: [{ action: 'replace', path: 'AGENTS.md' }] }
        }
      });
    },
    user(text, source) {
      emit({
        type: 'user/message',
        data: {
          content: [{ type: 'text', text }],
          source: source ?? { kind: 'user' }
        }
      });
    },
    // rc.2 起 agent loop 会自己追加这类事件, 见下面 developer/message 的用例.
    developerToolChange(content) {
      emit({
        type: 'developer/message',
        data: {
          message: { id: 'developer-1', role: 'developer', source: { kind: 'tool-registry' }, content }
        }
      });
    },
    preExecute() {
      return handlers.get('tools/pre-execute')({ agent }, async () => ({ kind: 'allow' }));
    },
    turnStopping() {
      handlers.get('agent/turn-stopping')({ agent });
    }
  };
}

test('引用会话或用户原文里出现 Updated instructions from: 不算变化', async () => {
  const gate = createHarness();
  const quoted = [
    '不会给这份文件做 digest / version 缓存',
    '后面文件改了也不会注入 `Updated instructions from: ...`',
    '`dsh-agents-md-notice-gate` (也就是 `[[REQ-AGENTS]]` / `[[ACK-AGENTS]]`) 是 Host 级插件',
  ].join('\n');

  gate.user(quoted, { kind: 'session-reference' });
  gate.assistant('那个 session 里, **用户第一次发出的原话** 就是:\n\n> 现在terminal 的preset有进入 .dsh 的版本追踪吗?');
  gate.turnStopping();

  assert.deepEqual(gate.steers, []);
  assert.deepEqual(await gate.preExecute(), { kind: 'allow' });
});

test('没有待确认变化时, 模型自行输出的 marker 被忽视', async () => {
  const gate = createHarness();
  gate.assistant(gate.acknowledgment);
  gate.turnStopping();

  assert.deepEqual(gate.steers, []);
  assert.deepEqual(await gate.preExecute(), { kind: 'allow' });
});

test('变化提示之后未确认, 工具调用被拒绝且本轮被追问', async () => {
  const gate = createHarness();
  gate.instructionChange('Updated instructions from: AGENTS.md\n\n新规则\n');

  const decision = await gate.preExecute();
  assert.equal(decision.kind, 'deny');
  assert.equal(decision.reason.includes('AGENTS 变化尚未确认'), true);

  gate.assistant('我先看看代码.');
  const retry = await gate.preExecute();
  assert.equal(retry.kind, 'deny');
  assert.equal(retry.reason.includes('AGENTS 变化确认格式不正确'), true);

  gate.turnStopping();
  assert.equal(gate.steers.length, 1);
  assert.equal(gate.steers[0].includes('AGENTS 变化确认格式不正确'), true);
});

test('确认一次真实变化之后中断本轮, 会被提醒继续', async () => {
  const gate = createHarness();
  gate.instructionChange('Updated instructions from: AGENTS.md\n\n新规则\n');
  gate.assistant(gate.acknowledgment);
  gate.turnStopping();

  assert.equal(gate.steers.length, 1);
  assert.equal(gate.steers[0].includes('不要在确认回应之后中断本轮工作'), true);
  assert.deepEqual(await gate.preExecute(), { kind: 'allow' });
});

test('确认并继续工作之后正常结束, 不会被再次追问', async () => {
  const gate = createHarness();
  gate.instructionChange('Updated instructions from: AGENTS.md\n\n新规则\n');
  gate.assistant(gate.acknowledgment);
  assert.deepEqual(await gate.preExecute(), { kind: 'allow' });
  gate.assistant('工作已经完成.');
  gate.turnStopping();

  assert.deepEqual(gate.steers, []);
});

// rc.2 起, agent loop 在工具表变化时会自行往会话日志追加 `developer/message`
// (source.kind 为 tool-registry, 内容为 tool-addition / tool-removal).
// 本插件会遍历会话事件, 这类事件既不改变门禁状态, 也不构成确认回应.
test('rc.2 的 developer/message 不参与门禁判定', async () => {
  const gate = createHarness();
  gate.instructionChange('Updated instructions from: AGENTS.md\n\n新规则\n');
  gate.developerToolChange([{ type: 'tool-addition', toolName: 'fetch' }]);

  // 工具表变化没有解除门禁.
  assert.equal((await gate.preExecute()).kind, 'deny');

  // 即使 developer 事件的载荷里出现 marker 文本, 也不算确认.
  gate.developerToolChange([{ type: 'text', text: gate.acknowledgment }]);
  assert.equal((await gate.preExecute()).kind, 'deny');

  // 确认之后, 夹在中间的 developer 事件不干扰确认识别与后续追问.
  gate.assistant(gate.acknowledgment);
  gate.developerToolChange([{ type: 'tool-removal', toolName: 'fetch' }]);
  assert.deepEqual(await gate.preExecute(), { kind: 'allow' });
  gate.turnStopping();

  assert.equal(gate.steers.length, 1);
  assert.equal(gate.steers[0].includes('不要在确认回应之后中断本轮工作'), true);
});
