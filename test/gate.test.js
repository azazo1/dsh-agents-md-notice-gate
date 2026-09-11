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
    preExecute() {
      return handlers.get('tools/pre-execute')({ agent }, async () => ({ kind: 'allow' }));
    },
    turnStopping() {
      handlers.get('agent/turn-stopping')({ agent });
    }
  };
}

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
