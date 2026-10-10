// Fictional project shared by the CLI recording and real-client captures.
// These values never execute tools or call a model.
export const prompt = 'Add Unicode regression tests to the tokenizer. Run them.';
export const question = {
  question: 'Which Unicode cases should the tests cover?',
  options: [
    { label: 'Emoji only', description: 'Keep the change minimal.' },
    { label: 'Emoji, combining marks & CJK', description: 'Cover all three Unicode cases.' },
  ],
};
export const answer = question.options[1].label;
export const source = 'const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });\nexport const tokenize = text => [...segmenter.segment(text)].map(x => x.segment);';
export const additions = [
  'test("emoji", () => assert.deepEqual(tokenize("😀"), ["😀"]));',
  'test("combining", () => assert.deepEqual(tokenize("e\\u0301"), ["e\\u0301"]));',
  'test("CJK", () => assert.deepEqual(tokenize("中文"), ["中", "文"]));',
];
export const testOutput = '✔ ASCII  ✔ Emoji  ✔ Combining marks  ✔ CJK\nTests: 4 passed, 0 failed';
export const delivery = 'Added **3 Unicode regression tests**. All **4 tests pass**.\nThe tokenizer implementation is unchanged.';
export const calls = [
  { tool_call_id: 'read-source', tool_name: 'read_file', arguments: { file_path: 'src/tokenizer.js' }, data: source, duration_ms: 310 },
  { tool_call_id: 'ask-scope', tool_name: 'ask_user_question', arguments: question, data: { answer }, duration_ms: 3400 },
  { tool_call_id: 'edit-tests', tool_name: 'edit_file', arguments: { file_path: 'test/tokenizer.test.js', old_string: '// Unicode cases', new_string: additions.join('\n') }, data: { path: 'test/tokenizer.test.js' }, meta: { files: [{ path: 'test/tokenizer.test.js', added_lines: 3, removed_lines: 1, diff: ['-// Unicode cases', ...additions.map(line => `+${line}`)].join('\n') }] }, duration_ms: 430 },
  { tool_call_id: 'run-tests', tool_name: 'bash', arguments: { command: 'npm test' }, data: { stdout: testOutput, stderr: '', exit_code: 0, status: 'completed' }, duration_ms: 820 },
];
export const fileChange = { lines: [{ kind: 'removed', text: '// Unicode cases' }, ...additions.map(text => ({ kind: 'added', text }))] };
export const messages = [{ role: 'user', content: prompt }];
for (const call of calls) {
  messages.push({ role: 'assistant', content: '', tool_calls: [{ id: call.tool_call_id, function: { name: call.tool_name, arguments: JSON.stringify(call.arguments) } }] });
  messages.push({ role: 'tool', tool_call_id: call.tool_call_id, content: JSON.stringify({ ok: true, tool: call.tool_name, data: call.data, meta: call.meta || {} }) });
}
messages.push({ role: 'assistant', content: delivery });
messages.forEach((message, index) => { message.ts = new Date(Date.UTC(2026, 9, 10, 9, 30, index * 2)).toISOString(); });

export const session = { id: 'unicode-demo', title: 'Unicode regression tests', workspace_root: '/projects/unicode-parser', updated_at: '2026-10-10T09:30:24Z' };
export const info = { session_id: session.id, workspace_root: session.workspace_root, cwd: '~/unicode-parser', model: 'zai/glm-4.7', reasoning_effort: 'high', version: '0.10.0' };
export const cliInfo = { ...info, model: 'GPT-6-Astra' };
export function rpcResult(method) {
  if (method === 'initialize' || method === 'session/switch') return info;
  if (method === 'session/list') return { sessions: [session] };
  if (method === 'session/replay') return { ...info, messages };
  if (method === 'model/list') return { models: [{ id: 'glm-4.7', provider_id: 'zai', provider_name: 'Z.ai' }], current_model_id: 'glm-4.7', current_provider_id: 'zai' };
  if (method === 'ping') return { pong: true };
  if (method === 'session/subscribe' || method === 'session/unsubscribe') return { session_id: session.id };
  throw new Error(`Unsupported capture RPC: ${method}`);
}
