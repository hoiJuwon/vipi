#!/usr/bin/env node
// Uses the installed Pi's loader; no new dependencies or live model calls.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const piRoot = process.env.PI_INSTALL_ROOT || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const { createJiti } = await import(pathToFileURL(join(piRoot, 'node_modules/jiti/lib/jiti.mjs')));
const home = mkdtempSync(join(tmpdir(), 'vipi-title-test-'));
const originalHome = process.env.HOME;
const originalTmux = process.env.TMUX;
const originalTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
process.env.HOME = home;
process.env.TMUX = 'fixture';
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
try {
  const jiti = createJiti(import.meta.url, { alias: { '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js') } });
  const { default: extension } = await jiti.import('../pi/packages/pi-session-tree/index.ts');
  const hooks = new Map(), commands = new Map(), notices = [], prompts = [];
  let name, sessionId = 'fixture', reply = { stopReason: 'stop', content: [{ type: 'text', text: '디스크 정리 후보 점검' }] };
  let duringRequest = () => {};
  const pi = { on: (event, fn) => hooks.set(event, fn), events: { on() {} },
    registerCommand: (id, command) => commands.set(id, command), getSessionName: () => name, setSessionName: (value) => { name = value; } };
  extension(pi);
  const first = '컴퓨터 용량 문제 한번 체크해줘. 안쓰는거 있는지 전체적으로 검수해줘. 지울만한 것들 리스트업해줘.';
  const ctx = { hasUI: true, ui: { notify: (...args) => notices.push(args) },
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [{ type: 'message', message: { role: 'user', content: first } }] },
    modelRegistry: { find: (provider, id) => { assert.equal(id, 'gpt-6-astra'); return { provider, id }; },
      hasConfiguredAuth: () => true, complete: async (_model, context, options) => {
        assert.equal(options.reasoningEffort, 'low'); assert.equal(options.transport, 'sse');
        prompts.push(context.messages[0].content[0].text); duringRequest(); return reply;
      } } };
  const turn = async () => { hooks.get('before_agent_start')({ prompt: '후속 질문은 이름에 쓰지 마' }, ctx); await new Promise(resolve => setImmediate(resolve)); };
  reply = { stopReason: 'error', errorMessage: 'model not supported', content: [] };
  await turn(); assert.equal(name, undefined); assert.match(notices.at(-1)[0], /model not supported/);
  reply = { stopReason: 'stop', content: [{ type: 'text', text: '디스크 정리 후보 점검' }] };
  await turn(); assert.equal(name, '기타 / 디스크 정리 후보 점검');
  assert.ok(prompts.every(p => p.includes(first) && !p.includes('후속 질문')));
  const calls = prompts.length; await turn(); assert.equal(prompts.length, calls, 'completed title must stay fixed');
  name = '기타 / 컴퓨터 용량 문제 한번 체크해줘';
  await commands.get('retitle').handler('', ctx); assert.equal(name, '기타 / 디스크 정리 후보 점검');
  duringRequest = () => { name = '개발 / 직접 지정'; };
  await commands.get('retitle').handler('', ctx); assert.equal(name, '개발 / 직접 지정');
  duringRequest = () => { sessionId = 'other'; };
  await commands.get('retitle').handler('', ctx); assert.equal(name, '개발 / 직접 지정');
  sessionId = 'fixture'; duringRequest = () => {};
  reply = { stopReason: 'stop', content: [] };
  await commands.get('retitle').handler('', ctx); assert.equal(name, '개발 / 직접 지정');
  const registry = join(home, '.pi/agent/tmux-session-tree.json'); mkdirSync(join(home, '.pi/agent'), { recursive: true });
  reply = { stopReason: 'stop', content: [{ type: 'text', text: '요약 완료' }] };
  duringRequest = () => writeFileSync(registry, JSON.stringify({ entries: [{ piSessionId: 'fixture', name: '개발 / 트리 직접 지정', cwd: home, tmuxSession: 'test', tmuxWindow: '1', tmuxPaneId: '%1', pid: 1, lastSeen: new Date().toISOString() }] }));
  await commands.get('retitle').handler('', ctx); assert.equal(name, '개발 / 직접 지정', 'tree rename wins over pending AI');
  console.log('PASS: provider error, retry, first-request summary, stable name, retitle, manual/tree rename and session-switch guards');
} finally {
  process.env.HOME = originalHome;
  if (originalTmux === undefined) delete process.env.TMUX; else process.env.TMUX = originalTmux;
  if (originalTTY) Object.defineProperty(process.stdout, 'isTTY', originalTTY); else delete process.stdout.isTTY;
  rmSync(home, { recursive: true, force: true });
}
