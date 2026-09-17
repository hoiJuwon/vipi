import { ModelRuntime, getAgentDir, readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Provider } from "@earendil-works/pi-ai";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ACCOUNT_IDS = ["openai-codex", "openai-codex-2"] as const;
const STATE = join(getAgentDir(), "codex-accounts");
const POLL_MS = 60_000;
type Window = { minutes: number; used: number; reset?: number };
export type Usage = { checkedAt: number; windows: Window[]; limited: boolean; fingerprint?: string; error?: string };
type Account = { number: number; connected: boolean; active: boolean; email?: string; usage?: Usage };

export function accountId(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  const id = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (typeof id !== "string" || !id) throw new Error("Codex OAuth 계정 식별자 없음");
  return id;
}
export function accountEmail(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    const email = payload["https://api.openai.com/profile"]?.email ?? payload.email;
    return typeof email === "string" && email.length <= 254 && /^[^\s\x00-\x1f\x7f|]+@[^\s\x00-\x1f\x7f|]+$/u.test(email) ? email : undefined;
  } catch { return undefined; }
}

export function accountRows(accounts: Account[], now = Date.now()): { text: string; active: boolean }[] {
  return accounts.map(account => {
    if (!account.connected) return { text: `account${account.number} not connected`, active: false };
    const usage = account.usage;
    const window = usage?.windows.find(w => Math.abs(w.minutes - 10080) <= 60)
      ?? [...(usage?.windows ?? [])].sort((a, b) => b.minutes - a.minutes)[0];
    const stale = usage?.error || (usage && now - usage.checkedAt > 2 * POLL_MS);
    const remaining = !window ? (usage?.error ? "unavailable" : "checking...")
      : window.reset && window.reset * 1000 <= now ? "checking..."
      : `${stale ? "~" : ""}${Math.round(100 - window.used)}% Left`;
    return { text: `${account.email ?? `account${account.number}`} | Usage ${remaining}`, active: account.active };
  });
}

function fingerprint(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}
function credentialIdentity(id: string): string | undefined {
  const credential = readStoredCredential(id);
  return credential?.type === "oauth" ? fingerprint(accountId(credential.access)) : undefined;
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
export function usageFromBody(body: any, now = Date.now()): Usage {
  const rate = body?.rate_limit;
  if (!rate || typeof rate.limit_reached !== "boolean") throw new Error("Codex 사용량 응답 형식 변경");
  const windows: Window[] = [];
  for (const window of [rate.primary_window, rate.secondary_window]) {
    if (!window || !finite(window.used_percent) || !finite(window.limit_window_seconds) || window.limit_window_seconds <= 0) continue;
    windows.push({ minutes: window.limit_window_seconds / 60, used: Math.max(0, Math.min(100, window.used_percent)),
      reset: finite(window.reset_at) ? window.reset_at : undefined });
  }
  return { checkedAt: now, windows, limited: rate.limit_reached || rate.allowed === false };
}
export function usageFromHeaders(raw: Record<string, string>, now = Date.now()): Usage | undefined {
  const headers = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
  const windows: Window[] = [];
  for (const slot of ["primary", "secondary"]) {
    const prefix = `x-codex-${slot}`;
    const used = Number.parseFloat(headers[`${prefix}-used-percent`] ?? "");
    const minutes = Number.parseFloat(headers[`${prefix}-window-minutes`] ?? "");
    const reset = Number.parseFloat(headers[`${prefix}-reset-at`] ?? "");
    if (Number.isFinite(used) && Number.isFinite(minutes) && minutes > 0) {
      windows.push({ used: Math.max(0, Math.min(100, used)), minutes, reset: Number.isFinite(reset) ? reset : undefined });
    }
  }
  return windows.length ? { checkedAt: now, windows, limited: windows.some(w => w.used >= 100) } : undefined;
}
export function exhausted(usage: Usage | undefined, now = Date.now()): boolean {
  if (!usage || usage.error) return false;
  const full = usage.windows.filter(w => w.used >= 100);
  if (full.length) return full.some(w => w.reset ? w.reset * 1000 > now : now - usage.checkedAt < POLL_MS);
  return usage.limited && now - usage.checkedAt < POLL_MS;
}
export function formatAccounts(accounts: Account[], now = Date.now()): string {
  return accounts.map(a => {
    const label = `${a.number}${a.active ? "*" : ""}`;
    if (!a.connected) return `${label} 미연결`;
    if (!a.usage?.windows.length) return `${label} ${a.usage?.error ? "조회 실패" : "조회 중"}`;
    const stale = a.usage.error || now - a.usage.checkedAt > 2 * POLL_MS;
    const windows = [...a.usage.windows].sort((a, b) => a.minutes - b.minutes).map(w => {
      const period = Math.abs(w.minutes - 10080) <= 60 ? "주" : w.minutes >= 60 ? `${Math.round(w.minutes / 60)}h` : `${w.minutes}m`;
      const value = w.reset && w.reset * 1000 <= now ? "?" : `${Math.round(100 - w.used)}%`;
      return `${period}${stale ? "~" : ""}${value}`;
    });
    return `${label} ${windows.join("/")}`;
  }).join(" · ");
}

// A model response is retried only before ANY start/content event, and only for
// confirmed quota exhaustion. Tool execution is outside this wrapper and is never replayed.
export function routeStream(
  model: any,
  candidates: number[],
  attempt: (account: number) => Promise<{ stream: AssistantMessageEventStream; quota: () => boolean }>,
  signal?: AbortSignal,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      if (!candidates.length) throw new Error("Codex 계정 사용량이 모두 소진됐습니다. /codex-accounts에서 초기화 시각을 확인하세요.");
      for (let index = 0; index < candidates.length; index++) {
        if (signal?.aborted) throw new Error("Request was aborted");
        const request = await attempt(candidates[index]);
        let emitted = false;
        let terminal = false;
        for await (const event of request.stream) {
          if (event.type === "error" && event.reason !== "aborted" && !signal?.aborted && !emitted
              && request.quota() && index + 1 < candidates.length) {
            terminal = true;
            break;
          }
          if (event.type === "error" || event.type === "done") {
            if (event.type === "error" && event.reason !== "aborted" && !emitted && request.quota()) {
              output.push({ ...event, error: { ...event.error,
                errorMessage: "연결된 Codex 계정 사용량이 소진됐습니다. /codex-accounts에서 초기화 시각 또는 두 번째 계정 연결을 확인하세요." } });
              output.end();
              return;
            }
            output.push(event);
            output.end();
            return;
          }
          emitted = true;
          output.push(event);
        }
        if (!terminal) throw new Error("Codex stream ended without a terminal event");
      }
    } catch (error) {
      const message: AssistantMessage = {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(), stopReason: signal?.aborted ? "aborted" : "error",
        errorMessage: error instanceof Error ? error.message : "Codex account request failed",
      };
      output.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
      output.end();
    }
  })();
  return output;
}

export default async function codexAccounts(pi: ExtensionAPI) {
  // Uses Pi's existing file-locked CredentialStore. Never copy/rotate auth.json.
  const runtime = await ModelRuntime.create();
  const base = runtime.getProvider(ACCOUNT_IDS[0]);
  if (!base?.auth.oauth) throw new Error("Codex native OAuth provider unavailable");
  let active = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const identity = (index: number) => credentialIdentity(ACCOUNT_IDS[index]);
  const statePath = (index: number) => join(STATE, `${index + 1}.json`);
  function readUsage(index: number): Usage | undefined {
    try {
      const value = JSON.parse(readFileSync(statePath(index), "utf8")) as Usage;
      return value.fingerprint === identity(index) && finite(value.checkedAt) && Array.isArray(value.windows) ? value : undefined;
    } catch { return undefined; }
  }
  function saveUsage(index: number, usage: Usage, who: string): void {
    // Cache writes are atomic and advisory; auth locking remains Pi-owned.
    // ponytail: last-writer-wins usage cache, add timestamp-ordered locking if real races appear.
    mkdirSync(STATE, { recursive: true, mode: 0o700 });
    const temporary = `${statePath(index)}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ ...usage, fingerprint: who }), { mode: 0o600 });
    renameSync(temporary, statePath(index));
  }
  function accounts(): Account[] {
    return ACCOUNT_IDS.map((id, index) => {
      const credential = readStoredCredential(id);
      return { number: index + 1, connected: Boolean(identity(index)), active: index === active,
        email: credential?.type === "oauth" ? accountEmail(credential.access) : undefined, usage: readUsage(index) };
    });
  }
  function publish(): void {
    if (!stopped) {
      const values = accounts();
      pi.events.emit("vipi:codex-accounts", { text: formatAccounts(values), rows: accountRows(values) });
    }
  }
  async function refreshUsage(index: number, force = false, signal?: AbortSignal): Promise<Usage | undefined> {
    const who = identity(index);
    if (!who) return undefined;
    const previous = readUsage(index);
    if (!force && previous && Date.now() - previous.checkedAt < POLL_MS) return previous;
    mkdirSync(STATE, { recursive: true, mode: 0o700 });
    const lease = join(STATE, `${index + 1}.poll-lock`);
    try { mkdirSync(lease, { mode: 0o700 }); }
    catch (error: any) {
      if (error.code !== "EEXIST") throw error;
      // Polling is best effort: a crashed poll expires, never an OAuth lock.
      try { if (Date.now() - statSync(lease).mtimeMs > 120_000) rmdirSync(lease); } catch {}
      return previous;
    }
    try {
      const timeout = AbortSignal.timeout(15_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const auth = await runtime.getAuth(ACCOUNT_IDS[index], { signal: requestSignal });
      if (!auth?.auth.apiKey) throw new Error("OAuth 로그인 필요");
      const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
        headers: { Authorization: `Bearer ${auth.auth.apiKey}`, "ChatGPT-Account-Id": accountId(auth.auth.apiKey) },
        signal: requestSignal,
      });
      if (!response.ok) throw new Error(`사용량 HTTP ${response.status}`);
      const usage = usageFromBody(await response.json());
      saveUsage(index, usage, fingerprint(accountId(auth.auth.apiKey)));
      return usage;
    } catch {
      const failed = { ...previous, windows: previous?.windows ?? [], limited: false, checkedAt: Date.now(), error: "사용량 조회 실패" };
      saveUsage(index, failed, who);
      return failed;
    } finally {
      rmdirSync(lease);
      publish();
    }
  }
  function oauthFor(index: number) {
    return { ...base!.auth.oauth!, name: `Codex 계정 ${index + 1} (ChatGPT)`,
      async login(interaction: any) {
        const credential = await base!.auth.oauth!.login(interaction);
        if (fingerprint(accountId(credential.access)) === identity(1 - index)) {
          throw new Error("다른 슬롯과 같은 Codex 계정입니다. 브라우저에서 다른 계정으로 로그인하세요.");
        }
        return credential;
      },
    };
  }
  // Login-only alias must not inherit the base's stateful catalog refresh:
  // refreshing an empty alias store would reset the shared account-1 catalog.
  const second: Provider = { ...base, id: ACCOUNT_IDS[1], name: "Codex 계정 2", auth: { oauth: oauthFor(1) },
    getModels: () => [], refreshModels: undefined, filterModels: undefined };
  runtime.registerNativeProvider(second);
  pi.registerProvider(second); // /login openai-codex-2 uses Pi's normal OAuth UI/storage.

  function stream(model: any, context: any, options: any = {}, simple = false): AssistantMessageEventStream {
    const generalQuota = !model.id.toLowerCase().includes("spark");
    const candidates = [active, 1 - active].filter(i => identity(i) && (!generalQuota || !exhausted(readUsage(i))));
    return routeStream(model, candidates, async index => {
      const auth = await runtime.getAuth(ACCOUNT_IDS[index], { signal: options.signal });
      if (!auth?.auth.apiKey) throw new Error(`Codex 계정 ${index + 1} 로그인이 필요합니다.`);
      active = index;
      publish();
      let quota = false;
      const who = fingerprint(accountId(auth.auth.apiKey));
      const selectedModel = { ...model, provider: ACCOUNT_IDS[index] };
      const accountOptions = { ...options, ...auth.auth, transport: "sse",
        sessionId: options.sessionId ? `${options.sessionId}:codex-${index + 1}` : undefined,
        async onResponse(response: any, responseModel: any) {
          const usage = usageFromHeaders(response.headers);
          if (usage && generalQuota) {
            try { saveUsage(index, usage, who); } catch { /* Quota cache is not required to stream a response. */ }
          }
          publish();
          await options.onResponse?.(response, responseModel);
          if (response.status === 429) {
            quota = exhausted(usage) || (generalQuota && exhausted(await refreshUsage(index, true, options.signal)));
            if (quota) throw new Error(`Codex account ${index + 1} usage limit confirmed`);
          }
        },
      };
      return { stream: simple ? base!.streamSimple(selectedModel, context, accountOptions) : base!.stream(selectedModel, context, accountOptions), quota: () => quota };
    }, options.signal);
  }
  pi.registerProvider({ ...base, name: "Codex 계정 1 / 자동 전환", auth: { ...base.auth, oauth: oauthFor(0) },
    stream: (model, context, options) => stream(model, context, options),
    streamSimple: (model, context, options) => stream(model, context, options, true),
  });

  async function tick(): Promise<void> {
    try { await Promise.all(ACCOUNT_IDS.map((_id, index) => refreshUsage(index))); publish(); } catch { /* Cache failure must not interrupt chat. */ }
  }
  pi.on("session_start", async () => {
    stopped = false;
    if (timer) clearInterval(timer);
    publish();
    void tick();
    timer = setInterval(() => { void tick(); }, 15_000);
    timer.unref?.();
  });
  pi.on("session_shutdown", () => { stopped = true; if (timer) clearInterval(timer); timer = undefined; });
  pi.registerCommand("codex-accounts", {
    description: "Show both Codex accounts, remaining quota and reset times",
    handler: async (_args, ctx) => {
      await Promise.all(ACCOUNT_IDS.map((_id, index) => refreshUsage(index, true)));
      const lines = accounts().map(a => {
        const resets = a.usage?.windows.map(w => `${Math.round(w.minutes / 60)}h 창: ${w.reset ? new Date(w.reset * 1000).toLocaleString() : "알 수 없음"}`).join(", ");
        return `${formatAccounts([a])}${resets ? ` — 초기화 ${resets}` : ""}`;
      });
      ctx.ui.notify(`${lines.join("\n")}\n계정 1: /login openai-codex\n계정 2: /login openai-codex-2\n* 현재 세션 사용 계정 · 숫자는 잔여량 · ~ 마지막 조회값`, "info");
    },
  });
}
