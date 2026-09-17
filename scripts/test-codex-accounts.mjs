#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.PI_INSTALL_ROOT || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const home = mkdtempSync(join(tmpdir(), 'vipi-accounts-test-'));
process.env.PI_CODING_AGENT_DIR = home;
const { createJiti } = await import(pathToFileURL(join(root, 'node_modules/jiti/lib/jiti.mjs')));
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
  '@earendil-works/pi-ai': join(root, 'node_modules/@earendil-works/pi-ai/dist/index.js'),
  '@earendil-works/pi-tui': join(root, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
} });
try {
  const mod = await jiti.import('../pi/packages/pi-codex-accounts/index.ts');
  const { createAssistantMessageEventStream } = await jiti.import('@earendil-works/pi-ai');
  const { ModelRuntime } = await jiti.import('@earendil-works/pi-coding-agent');
  const now = Date.now();
  const headers = { 'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': String(now / 1000 + 60) };
  assert.ok(mod.exhausted(mod.usageFromHeaders(headers)));
  assert.equal(mod.exhausted(mod.usageFromHeaders(headers), now + 61000), false);
  assert.equal(mod.usageFromHeaders({ 'x-codex-primary-used-percent': 'oops' }), undefined);
  assert.throws(() => mod.usageFromBody({}), /응답 형식/);
  const usage = mod.usageFromBody({ rate_limit: { allowed: true, limit_reached: false, primary_window: { used_percent: 54, limit_window_seconds: 604800, reset_at: now / 1000 + 86400 } } });
  assert.equal(mod.formatAccounts([{ number: 1, active: true, connected: true, usage }, { number: 2, active: false, connected: false }]), '1* 주46% · 2 미연결');
  assert.match(mod.formatAccounts([{ number: 1, active: true, connected: true, usage }], now + 180000), /~46%/);
  const model = { provider: 'openai-codex', api: 'openai-codex-responses', id: 'gpt-6-astra' };
  const msg = reason => ({ role: 'assistant', content: [], ...model, model: model.id, stopReason: reason, errorMessage: 'simulated' });
  function eventsStream(events) {
    const stream = createAssistantMessageEventStream();
    for (const event of events) stream.push(event);
    stream.end();
    return stream;
  }
  for (const [quota, emitted, expected] of [[true, false, 2], [false, false, 1], [true, true, 1]]) {
    const attempts = [];
    const output = mod.routeStream(model, [0, 1], async account => {
      attempts.push(account);
      return { quota: () => quota, stream: eventsStream(account === 0
        ? [...(emitted ? [{ type: 'toolcall_start', contentIndex: 0, partial: msg('pending') }] : []), { type: 'error', reason: 'error', error: msg('error') }]
        : [{ type: 'done', reason: 'stop', message: msg('stop') }]) };
    });
    await output.result(); assert.equal(attempts.length, expected, 'only pre-output confirmed quota retries');
  }
  const controller = new AbortController(); controller.abort();
  const aborted = mod.routeStream(model, [0, 1], async () => { throw Error('must not call'); }, controller.signal);
  assert.equal((await aborted.result()).stopReason, 'aborted');
  assert.match((await mod.routeStream(model, [], async () => {}).result()).errorMessage, /모두 소진/);

  // Full extension registration/dispatch against fake native OAuth & transport.
  const token = id => `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url')}.x`;
  const credentials = Object.fromEntries(mod.ACCOUNT_IDS.map((id, index) => [id, { type: 'oauth', access: token('account-' + index), refresh: 'test-only', expires: now + 999999 }]));
  writeFileSync(join(home, 'auth.json'), JSON.stringify(credentials), { mode: 0o600 });
  let loginCredential = credentials['openai-codex'];
  const calls = [], providers = new Map(), hooks = new Map(), published = [];
  const native = { id: 'openai-codex', name: 'Native', getModels: () => [model], refreshModels() {}, auth: { oauth: { login: async () => loginCredential } },
    stream(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        calls.push({ model, context, options });
        try {
          if (options.apiKey === credentials['openai-codex'].access) await options.onResponse({ status: 429, headers }, model);
          else await options.onResponse({ status: 200, headers: { ...headers, 'x-codex-primary-used-percent': '20' } }, model);
          stream.push({ type: 'done', reason: 'stop', message: msg('stop') });
        } catch (error) {
          stream.push({ type: 'error', reason: 'error', error: { ...msg('error'), errorMessage: error.message } });
        }
        stream.end();
      })();
      return stream;
    },
    streamSimple(...args) { return this.stream(...args); },
  };
  const originalCreate = ModelRuntime.create;
  ModelRuntime.create = async () => ({ getProvider: () => native, registerNativeProvider() {}, getAuth: async id => ({ auth: { apiKey: credentials[id].access } }) });
  try {
    await mod.default({ registerProvider: p => providers.set(p.id, p), registerCommand() {}, on: (e, f) => hooks.set(e, f), events: { emit: (...v) => published.push(v) } });
    assert.ok(providers.has('openai-codex-2'));
    assert.equal(providers.get('openai-codex-2').refreshModels, undefined, 'login alias must not reset the primary model catalog');
    assert.deepEqual(providers.get('openai-codex').getModels(), [model]);
    await assert.rejects(() => providers.get('openai-codex-2').auth.oauth.login({}), /같은 Codex 계정/);
    loginCredential = credentials['openai-codex-2'];
    await providers.get('openai-codex-2').auth.oauth.login({});
    const context = { messages: [], tools: [] };
    const result = await providers.get('openai-codex').stream(model, context, { sessionId: 'fixture', reasoningEffort: 'high' }).result();
    assert.equal(result.stopReason, 'stop'); assert.equal(calls.length, 2);
    assert.equal(calls[0].options.apiKey, credentials['openai-codex'].access);
    assert.equal(calls[1].options.apiKey, credentials['openai-codex-2'].access);
    assert.equal(calls[1].options.reasoningEffort, 'high');
    assert.equal(calls[1].model.provider, 'openai-codex-2');
    assert.notEqual(calls[0].options.sessionId, calls[1].options.sessionId);
    assert.strictEqual(calls[0].context, context); assert.strictEqual(calls[1].context, context);
    assert.match(published.at(-1)[1].text, /2\*/);
  } finally { ModelRuntime.create = originalCreate; hooks.get('session_shutdown')?.(); }

  // Footer must not mutate the user's high thinking setting on session_start.
  const { default: footer } = await jiti.import('../pi/packages/pi-clean-footer/index.ts');
  const footerEvents = new Map(), footerHooks = new Map(); let component;
  footer({ getThinkingLevel: () => 'high', setThinkingLevel: () => assert.fail('footer must not change thinking'),
    on: (e, fn) => footerHooks.set(e, fn), events: { on: (e, fn) => footerEvents.set(e, fn) } });
  footerEvents.get('vipi:codex-accounts')({ text: '1* 주46% · 2 주80%' });
  await footerHooks.get('session_start')({}, { mode: 'tui', ui: { setFooter: factory => { component = factory({ requestRender() {} }, { fg: (_color, text) => text }); } } });
  assert.match(component.render(120)[0], /Thinking: high.*1\* 주46% · 2 주80%/);
  console.log('PASS: quota parsing/reset/staleness, confirmed-only failover, no replay after output, abort, duplicate account guard, isolated tokens/session IDs, both-account footer, thinking preserved');
} finally { rmSync(home, { recursive: true, force: true }); }
