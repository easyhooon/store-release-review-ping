import { appleWorkerToken, validWorkerKeyConfig, type AppleWorkerKey } from "./apple-jwt.js";
import { validSignature } from "./apple-webhook-signature.js";
import {
  formatTestFlightMessage, parseBuilds, type BetaBuildNote, type TestFlightBuild,
} from "./testflight-format.js";

// 로컬 `testflight:watch`(src/testflight.ts)의 pollApp을 Cron Trigger와 D1로 옮긴 것이다.
// 상태 파일 대신 D1의 testflight_apps(기준점 저장 여부, lease)와 testflight_builds(본 빌드)를 쓴다.
// Apple의 BUILD_UPLOAD_STATE_UPDATED 웹훅은 "지금 한 번 조회하라"는 신호로만 쓴다. 업로드 COMPLETE 시점에는
// 빌드가 아직 PROCESSING일 수 있고, 그 경우 VALID 알림은 다음 Cron 실행이 보낸다.

interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

interface Database {
  prepare(sql: string): Statement;
  batch(statements: Statement[]): Promise<unknown[]>;
}

export interface TestFlightWorkerEnv extends AppleWorkerKey {
  DB: Database;
  APP_NAME: string;
  /** JSON 배열. 예: [{"appStoreId":"6475346701","label":"PRD"}] */
  TESTFLIGHT_APPS: string;
  DISCORD_WEBHOOK_URL: string;
  /** PRD·DEV 앱 웹훅에 같은 비밀값을 등록한다. */
  APPLE_WEBHOOK_SECRET: string;
}

interface WorkerApp {
  appStoreId: string;
  label: string;
}

const API_ORIGIN = "https://api.appstoreconnect.apple.com";
const REQUEST_TIMEOUT_MS = 15_000;
const BUILD_LIMIT = 50;
const LEASE_MS = 120_000;
// 웹훅의 waitUntil은 응답 후 약 30초만 보장된다. Discord 전송(최대 15초)이 그 안에 끝나도록,
// 웹훅 실행은 시작 후 이 시간이 지나면 새 전송을 시작하지 않고 Cron에 넘긴다.
const WEBHOOK_SEND_BUDGET_MS = 10_000;
const maxBodyBytes = 64 * 1024;

export function parseWorkerApps(raw: string): WorkerApp[] {
  const apps = JSON.parse(raw) as unknown;
  if (!Array.isArray(apps) || apps.length === 0) throw new Error("TESTFLIGHT_APPS에는 앱이 하나 이상 필요합니다.");
  const parsed = apps.map((value, index) => {
    const app = (value ?? {}) as Record<string, unknown>;
    if (typeof app.appStoreId !== "string" || !/^\d{1,20}$/.test(app.appStoreId)) {
      throw new Error(`TESTFLIGHT_APPS[${index}].appStoreId는 숫자 문자열이어야 합니다.`);
    }
    if (typeof app.label !== "string" || !app.label.trim()) {
      throw new Error(`TESTFLIGHT_APPS[${index}].label이 필요합니다.`);
    }
    return { appStoreId: app.appStoreId, label: app.label };
  });
  if (new Set(parsed.map((app) => app.appStoreId)).size !== parsed.length) {
    throw new Error("TESTFLIGHT_APPS에 같은 appStoreId가 중복되었습니다.");
  }
  return parsed;
}

export async function pollTestFlightWorker(
  env: TestFlightWorkerEnv, fetcher: typeof fetch = fetch, sendDeadline = Number.POSITIVE_INFINITY,
): Promise<{ notifications: number; baselines: number; skipped: number }> {
  if (!env.DB || !env.APP_NAME?.trim() || !env.DISCORD_WEBHOOK_URL || !validWorkerKeyConfig(env)) {
    throw new Error("TestFlight Worker 설정이 빠졌습니다.");
  }
  const apps = parseWorkerApps(env.TESTFLIGHT_APPS);
  const token = await appleWorkerToken(env);
  const get = async (url: URL): Promise<unknown> => {
    const response = await fetcher(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`App Store Connect 조회 실패: HTTP ${response.status} ${url.pathname}`);
    return response.json();
  };

  let notifications = 0;
  let baselines = 0;
  let skipped = 0;
  const errors: unknown[] = [];
  // 앱 하나의 실패가 다른 앱 알림을 막지 않도록 앱별로 처리하고, 실패는 끝에서 모아 던진다.
  for (const app of apps) {
    try {
      const result = await pollApp(env, app, get, fetcher, sendDeadline);
      notifications += result.notifications;
      baselines += result.baseline ? 1 : 0;
      skipped += result.skipped ? 1 : 0;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `TestFlight 조회 실패 ${errors.length}건 (알림 ${notifications}건 전송)`);
  }
  return { notifications, baselines, skipped };
}

async function pollApp(
  env: TestFlightWorkerEnv,
  app: WorkerApp,
  get: (url: URL) => Promise<unknown>,
  fetcher: typeof fetch,
  sendDeadline: number,
): Promise<{ notifications: number; baseline?: boolean; skipped?: boolean }> {
  const initialized = await env.DB.prepare("SELECT app_id FROM testflight_apps WHERE app_id = ?")
    .bind(app.appStoreId).first<{ app_id: string }>();
  if (!initialized) {
    // 처리 중인 빌드는 기준점에 넣지 않는다. 넣으면 처리가 끝나도 알림 없이 묻힌다.
    // 무료 플랜은 실행당 D1 쿼리가 50개라, 빌드마다 INSERT하지 않고 JSON 한 번으로 넣는다.
    const seen = (await listBuilds(app, get))
      .filter((build) => build.processingState !== "PROCESSING")
      .map((build) => ({ id: build.id, state: build.processingState }));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO testflight_builds (app_id, build_id, state)
         SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.state') FROM json_each(?)`,
      ).bind(app.appStoreId, JSON.stringify(seen)),
      env.DB.prepare("INSERT OR IGNORE INTO testflight_apps (app_id) VALUES (?)").bind(app.appStoreId),
    ]);
    return { notifications: 0, baseline: true };
  }

  // Cron과 웹훅이 같은 앱을 동시에 처리하면 같은 빌드를 두 번 보낸다. lease를 못 잡으면 다른 실행에 맡긴다.
  const token = crypto.randomUUID();
  const now = Date.now();
  const claimed = await env.DB.prepare(
    "UPDATE testflight_apps SET lease_until = ?, lease_token = ? WHERE app_id = ? AND lease_until < ?",
  ).bind(now + LEASE_MS, token, app.appStoreId, now).run();
  if (claimed.meta.changes === 0) return { notifications: 0, skipped: true };
  try {
    const builds = await listBuilds(app, get);
    const seenRows = await env.DB.prepare("SELECT build_id FROM testflight_builds WHERE app_id = ?")
      .bind(app.appStoreId).all<{ build_id: string }>();
    const seen = new Set(seenRows.results.map((row) => row.build_id));
    // lease를 가진 동안 SENDING이 남아 있다면 이전 실행이 전송 도중 끊긴 것이다. 알림이 빠졌을 수 있다.
    const stuck = await env.DB.prepare(
      "SELECT build_id FROM testflight_builds WHERE app_id = ? AND state = 'SENDING'",
    ).bind(app.appStoreId).all<{ build_id: string }>();
    if (stuck.results.length > 0) {
      console.warn(`TestFlight ${app.label} 전송 확인 안 된 빌드(SENDING): ${stuck.results.map((row) => row.build_id).join(", ")}`);
    }
    let notifications = 0;
    for (const build of [...builds].reverse()) {
      if (seen.has(build.id) || build.processingState === "PROCESSING") continue;
      // 실행이 길어져 lease가 만료되면 다른 실행이 같은 빌드를 보낼 수 있다. 보내기 전마다 연장하고, 뺏겼으면 멈춘다.
      const renewed = await env.DB.prepare(
        "UPDATE testflight_apps SET lease_until = ? WHERE app_id = ? AND lease_token = ?",
      ).bind(Date.now() + LEASE_MS, app.appStoreId, token).run();
      if (renewed.meta.changes === 0) break;
      if (build.processingState === "VALID") {
        const notes = await fetchNotes(build, get);
        if (Date.now() > sendDeadline) break;
        // 보내기 전에 SENDING으로 기록한다. 전송 후 기록 전에 실행이 잘려도(웹훅 waitUntil은 응답 후 약 30초)
        // 다음 실행이 같은 빌드를 다시 보내지 않는다. 대가로, 전송 도중 잘리면 그 빌드 알림은 빠지고
        // D1에 state = 'SENDING'으로 남는다.
        await env.DB.prepare(
          "INSERT OR REPLACE INTO testflight_builds (app_id, build_id, state) VALUES (?, ?, 'SENDING')",
        ).bind(app.appStoreId, build.id).run();
        try {
          await sendDiscord(env, formatTestFlightMessage({ appName: env.APP_NAME, label: app.label }, build, notes), fetcher);
        } catch (error) {
          // Discord가 4xx로 거절한 것이 확실할 때만 기록을 지워 다음 실행에서 다시 보낸다.
          // 타임아웃·네트워크 오류·5xx는 실제로 게시됐을 수 있어 SENDING을 남긴다(중복보다 누락을 택한다).
          if (error instanceof DiscordRejected) {
            try {
              await env.DB.prepare("DELETE FROM testflight_builds WHERE app_id = ? AND build_id = ? AND state = 'SENDING'")
                .bind(app.appStoreId, build.id).run();
            } catch (deleteError) {
              console.error("TestFlight SENDING 삭제 실패", deleteError instanceof Error ? deleteError.message : "unknown");
            }
          }
          throw error;
        }
        notifications++;
      }
      await markSeen(env, app, build).run();
    }
    return { notifications };
  } finally {
    // 해제에 실패해도 원래 오류를 덮지 않는다. 남은 lease는 LEASE_MS 뒤 만료된다.
    try {
      await env.DB.prepare(
        "UPDATE testflight_apps SET lease_until = 0, lease_token = '' WHERE app_id = ? AND lease_token = ?",
      ).bind(app.appStoreId, token).run();
    } catch (error) {
      console.error("TestFlight lease release failed", error instanceof Error ? error.message : "unknown");
    }
  }
}

async function listBuilds(app: WorkerApp, get: (url: URL) => Promise<unknown>): Promise<TestFlightBuild[]> {
  const url = new URL("/v1/builds", API_ORIGIN);
  url.searchParams.set("filter[app]", app.appStoreId);
  url.searchParams.set("sort", "-uploadedDate");
  url.searchParams.set("limit", String(BUILD_LIMIT));
  url.searchParams.set("include", "preReleaseVersion");
  url.searchParams.set("fields[builds]", "version,uploadedDate,processingState,preReleaseVersion");
  url.searchParams.set("fields[preReleaseVersions]", "version");
  return parseBuilds(await get(url));
}

function markSeen(env: TestFlightWorkerEnv, app: WorkerApp, build: TestFlightBuild): Statement {
  return env.DB.prepare(
    "INSERT OR REPLACE INTO testflight_builds (app_id, build_id, state) VALUES (?, ?, ?)",
  ).bind(app.appStoreId, build.id, build.processingState);
}

// 업데이트노트 조회가 실패해도 빌드 알림은 보낸다.
async function fetchNotes(build: TestFlightBuild, get: (url: URL) => Promise<unknown>): Promise<BetaBuildNote[]> {
  try {
    const url = new URL(`/v1/builds/${encodeURIComponent(build.id)}/betaBuildLocalizations`, API_ORIGIN);
    url.searchParams.set("fields[betaBuildLocalizations]", "locale,whatsNew");
    const page = await get(url) as { data?: Array<{ attributes?: { locale?: unknown; whatsNew?: unknown } }> };
    if (!Array.isArray(page.data)) throw new Error("betaBuildLocalizations 응답에 data 배열이 없습니다.");
    return page.data.flatMap((item) => {
      const locale = item.attributes?.locale;
      const whatsNew = item.attributes?.whatsNew;
      return typeof locale === "string" && typeof whatsNew === "string" ? [{ locale, whatsNew }] : [];
    });
  } catch (error) {
    console.warn(`${build.version} (${build.buildNumber}) 업데이트노트 조회 실패:`,
      error instanceof Error ? error.message : error);
    return [];
  }
}

async function sendDiscord(env: TestFlightWorkerEnv, content: string, fetcher: typeof fetch): Promise<void> {
  const url = new URL(env.DISCORD_WEBHOOK_URL);
  if (url.protocol !== "https:" || url.hostname !== "discord.com" ||
      !url.pathname.startsWith("/api/webhooks/")) throw new Error("Invalid Discord endpoint");
  url.searchParams.set("wait", "true");
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status >= 400 && response.status < 500) throw new DiscordRejected(response.status);
  if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
}

/** Discord가 요청을 받고 4xx로 거절했다. 메시지는 게시되지 않았다. */
class DiscordRejected extends Error {
  constructor(status: number) {
    super(`Discord HTTP ${status}`);
  }
}

type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

export async function handleBuildUploadWebhook(
  request: Request, env: TestFlightWorkerEnv, ctx: WaitUntil, fetcher: typeof fetch = fetch,
): Promise<Response> {
  if (new URL(request.url).pathname !== "/apple/build-upload") return new Response("Not found", { status: 404 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (!env.APPLE_WEBHOOK_SECRET) return new Response("Service unavailable", { status: 503 });
  let body: ArrayBuffer;
  try {
    body = await request.arrayBuffer();
  } catch {
    return new Response("Invalid body", { status: 400 });
  }
  if (body.byteLength > maxBodyBytes) return new Response("Body too large", { status: 413 });
  if (!(await validSignature(body, request.headers.get("x-apple-signature"), env.APPLE_WEBHOOK_SECRET))) {
    return new Response("Invalid signature", { status: 401 });
  }
  let event: { data?: { type?: string; attributes?: { newState?: string } } };
  try {
    event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  // ping과 COMPLETE가 아닌 업로드 상태는 조회하지 않는다. 페이로드에 앱 ID가 없어 등록한 앱을 모두 조회한다.
  if (event.data?.type !== "buildUploadStateUpdated" || event.data.attributes?.newState !== "COMPLETE") {
    return new Response(null, { status: 204 });
  }
  ctx.waitUntil(runPoll(env, "webhook", fetcher, Date.now() + WEBHOOK_SEND_BUDGET_MS));
  return new Response("Accepted", { status: 202 });
}

async function runPoll(
  env: TestFlightWorkerEnv, source: string, fetcher: typeof fetch = fetch, sendDeadline?: number,
): Promise<void> {
  try {
    const result = await pollTestFlightWorker(env, fetcher, sendDeadline);
    // 웹훅 실행에서 notifications=0이면 업로드 COMPLETE 시점에 빌드가 아직 PROCESSING이었다는 뜻이다.
    console.log(`TestFlight ${source} notifications=${result.notifications} baselines=${result.baselines} skipped=${result.skipped}`);
  } catch (error) {
    const details = error instanceof AggregateError
      ? error.errors.map((item) => item instanceof Error ? item.message : String(item)).join("; ")
      : "";
    console.error(`TestFlight ${source} poll failed`, error instanceof Error ? error.message : "unknown", details);
    throw error;
  }
}

export default {
  async scheduled(_controller: unknown, env: TestFlightWorkerEnv, ctx: WaitUntil) {
    ctx.waitUntil(runPoll(env, "cron"));
  },
  fetch(request: Request, env: TestFlightWorkerEnv, ctx: WaitUntil): Promise<Response> {
    return handleBuildUploadWebhook(request, env, ctx);
  },
};
