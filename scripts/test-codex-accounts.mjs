#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
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
  const rows = mod.accountRows([{ number: 1, active: true, connected: true, email: 'roy@example.com', usage }, { number: 2, active: false, connected: false }]);
  assert.deepEqual(rows, [{ text: 'roy@example.com | Usage 46% Left', active: true }, { text: 'account2 not connected', active: false }]);
  assert.match(mod.accountRows([{ number: 2, active: false, connected: true, email: 'second@example.com', usage }])[0].text, /^second@example.com \| Usage 46% Left$/);
  assert.match(mod.accountRows([{ number: 1, active: true, connected: true, usage }], now + 180000)[0].text, /~46% Left/);
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
  const badRequest = { type: 'error', reason: 'error', error: { ...msg('error'), errorMessage: '{"detail":"Bad Request"}' } };
  for (const failures of [1, 2, 9]) {
    const attempts = [], received = [];
    const output = mod.routeStream(model, [0, 1], async account => {
      attempts.push(account);
      return { quota: () => false, status: () => 400, stream: eventsStream(attempts.length <= failures
        ? [badRequest] : [{ type: 'done', reason: 'stop', message: msg('stop') }]) };
    });
    for await (const event of output) received.push(event);
    assert.deepEqual(attempts, Array(Math.min(failures + 1, 3)).fill(0), 'retry twice, same account only');
    assert.equal(received.length, 1, 'intermediate errors must not end the agent turn');
    assert.equal(received[0].type, failures > 2 ? 'error' : 'done');
    if (failures > 2) assert.match(received[0].error.errorMessage, /2회 즉시 재시도/);
  }
  for (const status of [401, 403, 429]) {
    let calls = 0;
    await mod.routeStream(model, [0, 1], async () => {
      calls++; return { quota: () => false, status: () => status, stream: eventsStream([badRequest]) };
    }).result();
    assert.equal(calls, 1, 'known auth/access/rate-limit errors are not generic retries');
  }
  for (const firstEvent of ['start', 'text_delta', 'toolcall_start']) {
    let calls = 0;
    await mod.routeStream(model, [0, 1], async () => {
      calls++; return { quota: () => false, stream: eventsStream([{ type: firstEvent, partial: msg('pending') }, badRequest]) };
    }).result();
    assert.equal(calls, 1, 'no retry after any emitted event');
  }
  for (const failure of [{ ...badRequest, reason: 'aborted' }, { ...badRequest, error: { ...badRequest.error, content: [{ type: 'text', text: 'partial' }] } }]) {
    let calls = 0;
    await mod.routeStream(model, [0, 1], async () => {
      calls++; return { quota: () => false, stream: eventsStream([failure]) };
    }).result();
    assert.equal(calls, 1, 'aborted/partial responses must not retry');
  }
  const controller = new AbortController(); controller.abort();
  const aborted = mod.routeStream(model, [0, 1], async () => { throw Error('must not call'); }, controller.signal);
  assert.equal((await aborted.result()).stopReason, 'aborted');
  assert.match((await mod.routeStream(model, [], async () => {}).result()).errorMessage, /모두 소진/);

  // Full extension registration/dispatch against fake native OAuth & transport.
  const token = id => `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: id } })).toString('base64url')}.x`;
  const emailToken = email => `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/profile': { email } })).toString('base64url')}.x`;
  assert.equal(mod.accountEmail(emailToken('roy@example.com')), 'roy@example.com');
  assert.equal(mod.accountEmail(emailToken('bad\u001b[31m@example.com')), undefined);
  assert.equal(mod.accountEmail('invalid'), undefined);
  const credentials = Object.fromEntries(mod.ACCOUNT_IDS.map((id, index) => [id, { type: 'oauth', access: token('account-' + index), refresh: 'test-only', expires: now + 999999 }]));
  writeFileSync(join(home, 'auth.json'), JSON.stringify(credentials), { mode: 0o600 });
  let loginCredential = credentials['openai-codex'], forcedBadRequests = 0;
  const calls = [], providers = new Map(), hooks = new Map(), commands = new Map(), serviceEvents = new Map(), published = [];
  const native = { id: 'openai-codex', name: 'Native', getModels: () => [model], refreshModels() {}, auth: { oauth: { login: async () => loginCredential } },
    stream(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        calls.push({ model, context, options });
        try {
          if (forcedBadRequests > 0) {
            forcedBadRequests--;
            await options.onResponse({ status: 400, headers: {} }, model);
            throw new Error('{"detail":"Bad Request"}');
          }
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
    await mod.default({ registerProvider: p => providers.set(p.id, p), registerCommand: (name, command) => commands.set(name, command), on: (e, f) => hooks.set(e, f), events: { on: (e, fn) => serviceEvents.set(e, fn), emit: (...v) => published.push(v) } });
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
    const previousPublications = published.length;
    serviceEvents.get('vipi:codex-accounts:request')();
    assert.equal(published.length, previousPublications + 1, 'live service must answer footer handshake');
    const notices = [], ui = { notify: text => notices.push(text) };
    const preferencePath = join(home, 'codex-accounts/preference.json');
    await commands.get('codex-accounts').handler('use 2', { ui });
    assert.equal(JSON.parse(readFileSync(preferencePath)).account, 2);
    assert.equal(statSync(preferencePath).mode & 0o777, 0o600);
    const selected = readFileSync(preferencePath, 'utf8');
    await commands.get('codex-accounts').handler('use 3', { ui });
    assert.equal(readFileSync(preferencePath, 'utf8'), selected);
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ 'openai-codex': credentials['openai-codex'] }));
    await commands.get('codex-accounts').handler('use 2', { ui });
    assert.match(notices.at(-1), /먼저 로그인/);
    assert.equal(readFileSync(preferencePath, 'utf8'), selected);
    writeFileSync(join(home, 'auth.json'), JSON.stringify(credentials));
    // A separate extension instance must start with the persisted account 2.
    await mod.default({ registerProvider: p => providers.set(p.id, p), registerCommand() {}, on() {}, events: { emit() {}, on() {} } });
    calls.length = 0;
    await providers.get('openai-codex').stream(model, context, {}).result();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.apiKey, credentials['openai-codex-2'].access);
    // Restored sessions may dispatch directly to the account-2 alias: it needs the same retry wrapper.
    calls.length = 0; forcedBadRequests = 2;
    const aliasResult = await providers.get('openai-codex-2').streamSimple({ ...model, provider: 'openai-codex-2' }, context, { sessionId: 'alias-fixture' }).result();
    assert.equal(aliasResult.stopReason, 'stop'); assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.strictEqual(call.context, context, 'retry must preserve completed tool results');
      assert.equal(call.options.apiKey, credentials['openai-codex-2'].access);
      assert.equal(call.options.sessionId, calls[0].options.sessionId);
    }
    // An external preference change applies on the next request, while quota fallback remains intact.
    rmSync(join(home, 'codex-accounts/1.json'));
    writeFileSync(preferencePath, JSON.stringify({ account: 1, revision: 'external-switch' }));
    calls.length = 0;
    await providers.get('openai-codex').stream(model, context, {}).result();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.apiKey, credentials['openai-codex'].access);
    assert.equal(calls[1].options.apiKey, credentials['openai-codex-2'].access);
  } finally { ModelRuntime.create = originalCreate; hooks.get('session_shutdown')?.(); }

  // Footer must not mutate the user's high thinking setting on session_start.
  const { default: footer } = await jiti.import('../pi/packages/pi-clean-footer/index.ts');
  const footerEvents = new Map(), footerHooks = new Map(); let component, renders = 0;
  footer({ getThinkingLevel: () => 'high', setThinkingLevel: () => assert.fail('footer must not change thinking'),
    on: (e, fn) => footerHooks.set(e, fn), events: { on: (e, fn) => footerEvents.set(e, fn), emit: (e, data) => footerEvents.get(e)?.(data) } });
  footerEvents.get('vipi:codex-accounts')({ rows });
  await footerHooks.get('session_start')({}, { mode: 'tui', ui: { setFooter: factory => { component = factory({ requestRender() { renders++; } }, { fg: (_color, text) => text }); } } });
  footerEvents.get('vipi:codex-accounts')({ rows });
  assert.equal(renders, 0, 'unchanged account data must not schedule a redraw');
  const rendered = component.render(120);
  assert.equal(rendered.length, 2);
  assert.match(rendered[0], /^NORMAL\s+roy@example.com \| Usage 46% Left$/);
  assert.match(rendered[1], /^Thinking: high\s+account2 not connected$/);
  const { visibleWidth } = await jiti.import('@earendil-works/pi-tui');
  for (const width of [0, 1, 12, 30, 60, 120]) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
  const { vimStateFromFooter } = await jiti.import('../pi/packages/pi-session-tree/index.ts');
  for (const [text, mode, expected] of [['NORMAL', 'normal', 'normal'], ['INSERT', 'insert', 'insert'], ['VISUAL LINE', 'visual-line', 'visual'], ['NORMAL g_', 'normal', 'pending'], [':sessions .', 'normal', 'ex']]) {
    footerEvents.get('pi-vim:status-line')({ text, mode });
    assert.equal(vimStateFromFooter(component.render(120).join('\n')), expected);
  }
  assert.equal(vimStateFromFooter('NORMAL    Thinking: high  Weekly Usage Limit: 43% remaining'), 'normal');
  assert.equal(vimStateFromFooter('no footer'), undefined);
  const { default: activity } = await jiti.import('../pi/packages/pi-activity-line/index.ts');
  const activityHooks = new Map(), updates = [];
  activity({ on: (e, fn) => activityHooks.set(e, fn), registerCommand() {} });
  const ctx = { mode: 'tui', ui: { setWorkingMessage: value => updates.push(value), setWorkingVisible() {} } };
  const originalNow = Date.now;
  try {
    Date.now = () => now;
    activityHooks.get('session_start')({}, ctx);
    activityHooks.get('agent_start')({}, ctx);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(updates.filter(Boolean).length, 1, 'same activity text must not redraw every timer tick');
    activityHooks.get('agent_settled')({}, ctx);
    const count = updates.length;
    await new Promise(resolve => setTimeout(resolve, 550));
    assert.equal(updates.length, count, 'idle must not leave an activity timer running');
  } finally { Date.now = originalNow; activityHooks.get('session_shutdown')({}, ctx); }
  console.log('PASS: immediate same-account Bad Request retry, bounded exhaustion, no replay/auth/abort retries, alias routing, account/footer/activity regressions');
} finally { rmSync(home, { recursive: true, force: true }); }
