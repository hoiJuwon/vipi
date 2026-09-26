#!/usr/bin/env node
// Exercise the installed image tool with mocked HTTP; never spend image quota.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.PI_INSTALL_ROOT || join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@earendil-works/pi-coding-agent');
const home = mkdtempSync(join(tmpdir(), 'vipi-image-account-test-'));
process.env.PI_CODING_AGENT_DIR = home;
process.env.PI_OFFLINE = '1';
const { createJiti } = await import(pathToFileURL(join(root, 'node_modules/jiti/lib/jiti.mjs')));
const jiti = createJiti(import.meta.url, { alias: {
  '@earendil-works/pi-coding-agent': join(root, 'dist/index.js'),
  '@earendil-works/pi-ai': join(root, 'node_modules/@earendil-works/pi-ai/dist/index.js'),
  'typebox': join(root, 'node_modules/typebox/build/index.mjs'),
} });
const packagePath = join(process.env.PI_IMAGEGEN_PACKAGE || process.env.HOME + '/.pi/agent/npm/node_modules/pi-codex-image-gen', 'extensions/index.ts');
try {
  const { default: install, selectedCodexProvider } = await jiti.import(packagePath);
  let tool;
  install({ registerTool: value => { tool = value; } });
  assert.equal(tool.name, 'codex_generate_image');
  const prefDir = join(home, 'codex-accounts'); mkdirSync(prefDir);
  const preference = account => writeFileSync(join(prefDir, 'preference.json'), JSON.stringify({ account, revision: String(account) }));
  const tokens = Object.fromEntries([1, 2, 3].map(n => {
    const jwt = `x.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: `fixture-${n}` } })).toString('base64url')}.x`;
    return [n === 1 ? 'openai-codex' : `openai-codex-${n}`, jwt];
  }));
  const { ModelRuntime, ModelRegistry } = await jiti.import('@earendil-works/pi-coding-agent');
  writeFileSync(join(home, 'auth.json'), JSON.stringify(Object.fromEntries(Object.entries(tokens).map(([id, access]) =>
    [id, { type: 'oauth', access, refresh: 'fixture-only', expires: Date.now() + 86400000 }]))), { mode: 0o600 });
  const runtime = await ModelRuntime.create();
  const base = runtime.getProvider('openai-codex');
  assert.ok(base?.auth.oauth);
  for (const id of ['openai-codex-2', 'openai-codex-3']) runtime.registerNativeProvider({ ...base, id, auth: { oauth: base.auth.oauth },
    getModels: () => [], refreshModels: undefined, filterModels: undefined });
  const registry = new ModelRegistry(runtime);
  const resolved = [];
  const ctx = { cwd: home, isProjectTrusted: () => false,
    modelRegistry: { find: () => undefined, async getApiKeyForProvider(id) { resolved.push(id); return registry.getApiKeyForProvider(id); } },
    sessionManager: { getSessionId: () => 'fixture', getBranch: () => [] } };
  let requests = 0;
  const originalFetch = globalThis.fetch;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==';
  globalThis.fetch = async (_url, init) => {
    requests++;
    const provider = resolved.at(-1);
    assert.equal(init.headers.Authorization, `Bearer ${tokens[provider]}`);
    assert.equal(init.headers['chatgpt-account-id'], `fixture-${provider.at(-1) === 'x' ? 1 : provider.at(-1)}`);
    const body = `data: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'image_generation_call', id: 'fixture', result: png } })}\n\n`;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    assert.equal(selectedCodexProvider(home), 'openai-codex');
    for (const number of [1, 3, 2, 1]) {
      preference(number);
      const provider = number === 1 ? 'openai-codex' : `openai-codex-${number}`;
      assert.equal(selectedCodexProvider(home), provider);
      const result = await tool.execute('fixture', { prompt: 'test fixture', save: 'none' }, undefined, undefined, ctx);
      assert.equal(result.details.provider, provider);
      assert.match(result.content[0].text, new RegExp(provider));
    }
    assert.equal(requests, 4);
    preference(3);
    ctx.modelRegistry.getApiKeyForProvider = async id => { resolved.push(id); return id === 'openai-codex-3' ? undefined : registry.getApiKeyForProvider(id); };
    await assert.rejects(tool.execute('fixture', { prompt: 'test', save: 'none' }, undefined, undefined, ctx), /Missing openai-codex-3 credentials/);
    assert.equal(requests, 4, 'missing account must not silently bill account 1');
    preference(4);
    await assert.rejects(tool.execute('fixture', { prompt: 'test', save: 'none' }, undefined, undefined, ctx), /Invalid Codex account preference/);
    assert.equal(requests, 4);
  } finally { globalThis.fetch = originalFetch; }
  console.log('PASS: image tool follows account 1/3/2/1 preference, correct OAuth token and account header; no fallback or network/image quota');
} finally { rmSync(home, { recursive: true, force: true }); }
