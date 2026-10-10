import test from 'node:test';
import assert from 'node:assert/strict';
import { prompt, question, answer, source, additions, calls, fileChange, messages, rpcResult } from './fixtures.mjs';
import { normalizeHistoryMessages, reduceConversation, emptyConversationState } from '../../frontend-web/src/state/conversationReducer.js';
import { toolView } from '../../frontend-web/src/lib/toolDisplay.js';

test('the example project really supports the four test cases shown', () => {
  const tokenize = new Function(source.replace('export const ', 'const ') + '; return tokenize;')();
  assert.deepEqual(tokenize('abc'), ['a', 'b', 'c']);
  const cases = [];
  new Function('test', 'assert', 'tokenize', additions.join('\n'))((name, run) => { run(); cases.push(name); }, assert, tokenize);
  assert.deepEqual(cases, ['emoji', 'combining', 'CJK']);
});

test('the question, answer, tool results and final report tell one coherent story', () => {
  assert.ok(prompt.includes('Unicode'));
  assert.equal(answer, question.options[1].label);
  assert.deepEqual(calls.map(call => call.tool_name), ['read_file', 'ask_user_question', 'edit_file', 'bash']);
  assert.equal(calls[3].data.exit_code, 0);
  assert.equal(fileChange.lines.filter(line => line.kind === 'added').length, 3);
  assert.equal(fileChange.lines.filter(line => line.kind === 'removed').length, 1);
  assert.equal(messages.at(-1).role, 'assistant');
  assert.match(messages.at(-1).content, /4 tests pass/);
});

test('real Web reducer handles the fixture replay and native protocol tool previews', () => {
  assert.equal(normalizeHistoryMessages(messages).filter(message => message.role === 'tool').length, 4);
  let state = reduceConversation(emptyConversationState(), { kind: 'history', messages });
  let sequence = 1;
  for (const call of calls) {
    for (const event of [
      { type: 'tool_requested', tool_call_id: call.tool_call_id, tool_name: call.tool_name, args_preview: JSON.stringify(call.arguments) },
      { type: 'tool_result', tool_call_id: call.tool_call_id, status: 'completed', result: JSON.stringify({ ok: true, data: call.data, meta: call.meta || {} }) },
    ]) state = reduceConversation(state, { kind: 'event', session_id: 'unicode-demo', turn_id: 'demo-turn', sequence: sequence++, durability: 'durable', event });
  }
  const tools = state.entries.filter(entry => entry.role === 'tool');
  assert.equal(tools.length, 4);
  assert.equal(toolView(tools[0]).target, 'src/tokenizer.js');
  assert.equal(toolView(tools[3]).target, 'npm test');
  assert.deepEqual(toolView(tools[2]).change, { added: 3, removed: 1 });
  assert.throws(() => rpcResult('session/prompt'), /Unsupported capture RPC/);
});
