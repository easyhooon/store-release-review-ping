import { observeLifecycle, type LifecycleState, type NotificationKind } from "./domain/lifecycle.js";
import { googleAccessToken, parseServiceAccount } from "./google-jwt.js";
import {
  formatMessage, parseEditTrackReleaseNotes, parseReleaseList,
  type ReleaseNote, type ReleaseObservation,
} from "./play-format.js";

// 로컬 `pnpm watch`(src/poller.ts)를 Cron Trigger와 D1로 옮긴 것이다. Worker 하나가 여러 앱을 조회한다.
// 무료 플랜은 계정당 Cron Trigger가 5개라 앱마다 Worker를 두지 않는다. 대신 서비스 계정, Discord 웹훅, D1을
// 앱별 비밀값·바인딩으로 나누고, lease와 오류도 앱별로 처리해 한 앱의 실패가 다른 앱 알림을 막지 않게 한다.
// 상태 파일 대신 D1의 play_releases(packageName·track·versionCode별 마지막 상태)와 play_apps(lease)를 쓴다.
// Google Play에는 심사 상태 웹훅이 없어(RTDN은 결제 전용) Cron 조회만 한다.

interface Statement {
  bind(...values: unknown[]): Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface Database {
  prepare(sql: string): Statement;
}

export interface PlayReleaseWorkerEnv {
  /**
   * JSON 배열. 앱마다 key를 정하면 `${key}_DB`(D1 바인딩), `${key}_GOOGLE_SERVICE_ACCOUNT_JSON`(서비스 계정
   * JSON 키 파일 내용), `${key}_DISCORD_WEBHOOK_URL`(비밀값)을 읽는다.
   * 예: [{"key":"YEOBEE","packageName":"com.yeobee","tracks":["internal","production"]}]
   */
  PLAY_APPS: string;
  [binding: string]: unknown;
}

export interface PlayAppConfig {
  key: string;
  packageName: string;
  tracks: string[];
}

interface PlayApp {
  db: Database;
  packageName: string;
  tracks: string[];
  serviceAccountJson: string;
  discordWebhookUrl: string;
}

interface StoredRow {
  track: string;
  version_code: number;
  state: string;
  sending: number;
}

const API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const REQUEST_TIMEOUT_MS = 15_000;
// 한 실행은 Google 조회(15초 제한) 몇 번과 Discord 전송이 전부라 5분이면 넉넉하다. 15분 Cron과도 겹치지 않는다.
const LEASE_MS = 300_000;

export function parsePlayApps(raw: string): PlayAppConfig[] {
  let apps: unknown;
  try {
    apps = JSON.parse(raw);
  } catch {
    throw new Error("PLAY_APPS는 JSON 배열이어야 합니다.");
  }
  if (!Array.isArray(apps) || apps.length === 0) throw new Error("PLAY_APPS에는 앱이 하나 이상 필요합니다.");
  const parsed = apps.map((value, index) => {
    const app = (value ?? {}) as Record<string, unknown>;
    if (typeof app.key !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(app.key)) {
      throw new Error(`PLAY_APPS[${index}].key는 대문자 환경 변수 접두어여야 합니다.`);
    }
    if (typeof app.packageName !== "string" || !/^[A-Za-z0-9_.]+$/.test(app.packageName)) {
      throw new Error(`PLAY_APPS[${index}].packageName이 올바르지 않습니다.`);
    }
    const tracks = app.tracks;
    if (!Array.isArray(tracks) || tracks.length === 0 ||
        !tracks.every((track) => typeof track === "string" && /^[A-Za-z0-9:_-]+$/.test(track))) {
      throw new Error(`PLAY_APPS[${index}].tracks에는 트랙 이름이 하나 이상 필요합니다.`);
    }
    return { key: app.key, packageName: app.packageName, tracks: [...new Set(tracks as string[])] };
  });
  if (new Set(parsed.map((app) => app.key)).size !== parsed.length ||
      new Set(parsed.map((app) => app.packageName)).size !== parsed.length) {
    throw new Error("PLAY_APPS에 같은 key나 packageName이 중복되었습니다.");
  }
  return parsed;
}

export async function pollPlayReleaseWorker(
  env: PlayReleaseWorkerEnv, fetcher: typeof fetch = fetch,
): Promise<{ checked: number; notifications: number; skipped: number }> {
  const apps = parsePlayApps(env.PLAY_APPS);
  let checked = 0;
  let notifications = 0;
  let skipped = 0;
  const errors: unknown[] = [];
  // 앱 하나의 실패(키 만료, 할당량, Discord 오류)가 다른 앱 알림을 막지 않도록 앱별로 처리하고, 실패는 끝에서 모아 던진다.
  for (const config of apps) {
    try {
      const result = await pollApp(resolveApp(env, config), fetcher);
      checked += result.checked;
      notifications += result.notifications;
      skipped += result.skipped ? 1 : 0;
    } catch (error) {
      errors.push(new Error(`${config.packageName}: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Play 조회 실패 ${errors.length}건 (알림 ${notifications}건 전송)`);
  }
  return { checked, notifications, skipped };
}

function resolveApp(env: PlayReleaseWorkerEnv, config: PlayAppConfig): PlayApp {
  const db = env[`${config.key}_DB`] as Database | undefined;
  const serviceAccountJson = env[`${config.key}_GOOGLE_SERVICE_ACCOUNT_JSON`];
  const discordWebhookUrl = env[`${config.key}_DISCORD_WEBHOOK_URL`];
  if (!db || typeof db.prepare !== "function" || typeof serviceAccountJson !== "string" || !serviceAccountJson ||
      typeof discordWebhookUrl !== "string" || !discordWebhookUrl) {
    throw new Error(`${config.key}_DB, ${config.key}_GOOGLE_SERVICE_ACCOUNT_JSON, ${config.key}_DISCORD_WEBHOOK_URL 중 빠진 설정이 있습니다.`);
  }
  // sending = 1을 기록한 뒤에 URL 오류가 나면 "게시됐을 수 있음"으로 남아 알림이 영구히 빠진다. lease·D1 쓰기 전에 검사한다.
  if (!validDiscordWebhook(discordWebhookUrl)) {
    throw new Error(`${config.key}_DISCORD_WEBHOOK_URL이 https://discord.com/api/webhooks/ 주소가 아닙니다.`);
  }
  return { db, packageName: config.packageName, tracks: config.tracks, serviceAccountJson, discordWebhookUrl };
}

async function pollApp(
  app: PlayApp, fetcher: typeof fetch,
): Promise<{ checked: number; notifications: number; skipped: boolean }> {
  const { packageName, tracks } = app;
  const account = parseServiceAccount(app.serviceAccountJson);

  // 실행이 겹치면(수동 실행, 이전 실행 지연) 같은 전환을 두 번 보낸다. lease를 못 잡으면 다른 실행에 맡긴다.
  const token = crypto.randomUUID();
  const now = Date.now();
  await app.db.prepare("INSERT OR IGNORE INTO play_apps (package_name) VALUES (?)").bind(packageName).run();
  const claimed = await app.db.prepare(
    "UPDATE play_apps SET lease_until = ?, lease_token = ? WHERE package_name = ? AND lease_until < ?",
  ).bind(now + LEASE_MS, token, packageName, now).run();
  if (claimed.meta.changes === 0) return { checked: 0, notifications: 0, skipped: true };

  try {
    const accessToken = await googleAccessToken(account, SCOPE, fetcher);
    const google = async (url: string, init: RequestInit = {}): Promise<unknown> => {
      const response = await fetcher(url, {
        ...init,
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", ...init.headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Google Play API 실패: HTTP ${response.status} ${init.method ?? "GET"} ${new URL(url).pathname}`);
      }
      return response.status === 204 ? null : response.json();
    };

    const observations = dedupe((await Promise.all(tracks.map(async (track) => parseReleaseList(
      await google(`${API_BASE}/applications/${encodeURIComponent(packageName)}/tracks/${encodeURIComponent(track)}/releases`),
      packageName, track,
    )))).flat());

    const rows = (await app.db.prepare(
      "SELECT track, version_code, state, sending FROM play_releases WHERE package_name = ?",
    ).bind(packageName).all<StoredRow>()).results;
    const stored = new Map(rows.map((row) => [releaseKey(row.track, row.version_code), row]));
    // 로컬 poller와 같게, 실행 시작 시점에 행이 하나라도 있는 트랙만 기준점을 가진 것으로 본다.
    const baselineTracks = new Set(rows.map((row) => row.track));
    const stuck = rows.filter((row) => row.sending === 1);
    if (stuck.length > 0) {
      // lease를 가진 동안 sending이 남아 있다면 이전 실행이 전송 도중 끊긴 것이다. 알림이 빠졌을 수 있다.
      console.warn(`Play ${packageName} 전송 확인 안 된 알림(sending=1): ${
        stuck.map((row) => `${row.track}/${row.version_code}=${row.state}`).join(", ")}`);
    }

    const pending: Array<{ observation: ReleaseObservation; previous: LifecycleState | null; kind: NotificationKind }> = [];
    const quiet: ReleaseObservation[] = [];
    for (const observation of observations) {
      const previous = (stored.get(releaseKey(observation.track, observation.versionCode))?.state ?? null) as
        LifecycleState | null;
      const kind = notificationFor(observation, previous, baselineTracks.has(observation.track));
      if (kind) pending.push({ observation, previous, kind });
      else quiet.push(observation);
    }

    // 알림 없는 관측(첫 기준점, IN_REVIEW 등)은 전송보다 먼저 한 쿼리로 저장한다. 전송이 실패해도 이 관측이
    // 저장돼야 다음 실행에서 IN_REVIEW → APPROVED 같은 전환을 알 수 있다. 무료 플랜은 실행당 D1 쿼리가 50개다.
    // 상태나 이름이 바뀐 행만 고쳐 D1 쓰기 수를 줄인다.
    if (quiet.length > 0) {
      await app.db.prepare(
        `INSERT INTO play_releases (package_name, track, version_code, state, release_name, observed_at)
         SELECT ?, json_extract(value, '$.track'), json_extract(value, '$.versionCode'),
                json_extract(value, '$.state'), json_extract(value, '$.releaseName'), ?
         FROM json_each(?) WHERE true
         ON CONFLICT (package_name, track, version_code) DO UPDATE SET
           state = excluded.state, release_name = excluded.release_name, observed_at = excluded.observed_at,
           sending = CASE WHEN play_releases.state IS excluded.state THEN play_releases.sending ELSE 0 END,
           previous_state = CASE WHEN play_releases.state IS excluded.state THEN play_releases.previous_state ELSE NULL END
         WHERE play_releases.state IS NOT excluded.state OR play_releases.release_name IS NOT excluded.release_name`,
      ).bind(packageName, new Date().toISOString(), JSON.stringify(quiet.map((observation) => ({
        track: observation.track,
        versionCode: observation.versionCode,
        state: observation.state,
        releaseName: observation.releaseName,
      })))).run();
    }

    let notifications = 0;
    const sendErrors: string[] = [];
    for (const { observation, previous, kind } of pending) {
      // 실행이 길어져 lease가 만료되면 다른 실행이 같은 전환을 보낼 수 있다. 보내기 전마다 연장하고, 뺏겼으면 멈춘다.
      const renewed = await app.db.prepare(
        "UPDATE play_apps SET lease_until = ? WHERE package_name = ? AND lease_token = ?",
      ).bind(Date.now() + LEASE_MS, packageName, token).run();
      if (renewed.meta.changes === 0) {
        console.warn(`Play ${packageName} lease를 잃어 남은 처리를 다음 실행에 넘깁니다.`);
        break;
      }

      const releaseNotes = kind === "internal-deployed"
        ? await fetchReleaseNotes(google, observation)
        : [];
      // 보내기 전에 새 상태와 sending = 1을 기록한다. 전송 후 기록 전에 실행이 잘려도 다음 실행이
      // 같은 전환을 다시 보내지 않는다(중복보다 누락을 택한다). 잘리면 sending = 1로 남아 다음 실행이 경고한다.
      await app.db.prepare(
        `INSERT INTO play_releases
           (package_name, track, version_code, state, release_name, observed_at, sending, previous_state)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT (package_name, track, version_code) DO UPDATE SET
           state = excluded.state, release_name = excluded.release_name, observed_at = excluded.observed_at,
           sending = 1, previous_state = excluded.previous_state`,
      ).bind(packageName, observation.track, observation.versionCode, observation.state,
        observation.releaseName, new Date().toISOString(), previous).run();
      try {
        await sendDiscord(app.discordWebhookUrl, formatMessage({
          kind, previous, release: observation, releaseNotes,
        }), fetcher);
      } catch (error) {
        // Discord가 4xx로 거절한 것이 확실할 때만 이전 상태로 되돌려 다음 실행에서 다시 보낸다.
        // 타임아웃·네트워크 오류·5xx는 실제로 게시됐을 수 있어 sending = 1을 남긴다.
        // 한 알림의 실패가 뒤 알림을 막지 않도록 다음 알림으로 넘어가고, 실패는 끝에서 던진다.
        if (error instanceof DiscordRejected) await revert(app, observation, previous);
        sendErrors.push(`${observation.track}/${observation.versionCode}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      await app.db.prepare(
        `UPDATE play_releases SET sending = 0, previous_state = NULL
         WHERE package_name = ? AND track = ? AND version_code = ?`,
      ).bind(packageName, observation.track, observation.versionCode).run();
      notifications++;
    }
    if (sendErrors.length > 0) {
      throw new Error(`Discord 전송 실패 ${sendErrors.length}건 (알림 ${notifications}건 전송): ${sendErrors.join("; ")}`);
    }
    return { checked: observations.length, notifications, skipped: false };
  } finally {
    // 해제에 실패해도 원래 오류를 덮지 않는다. 남은 lease는 LEASE_MS 뒤 만료된다.
    try {
      await app.db.prepare(
        "UPDATE play_apps SET lease_until = 0, lease_token = '' WHERE package_name = ? AND lease_token = ?",
      ).bind(packageName, token).run();
    } catch (error) {
      console.error("Play lease 해제 실패", error instanceof Error ? error.message : "unknown");
    }
  }
}

// src/poller.ts의 processObservation과 같은 규칙이다.
function notificationFor(
  observation: ReleaseObservation, previous: LifecycleState | null, trackHasBaseline: boolean,
): NotificationKind | null {
  if (previous === null && trackHasBaseline && observation.track === "internal" &&
      observation.state === "RELEASE_LIFECYCLE_STATE_PUBLISHED") {
    return "internal-deployed";
  }
  return observeLifecycle(previous, observation.state).notification;
}

// 한 트랙 응답에 같은 versionCode가 두 릴리스로 나올 수 있다. 같은 키를 한 실행에서 두 번 처리하지 않는다.
function dedupe(observations: ReleaseObservation[]): ReleaseObservation[] {
  const seen = new Set<string>();
  return observations.filter((observation) => {
    const key = releaseKey(observation.track, observation.versionCode);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function releaseKey(track: string, versionCode: number): string {
  return `${track}\0${versionCode}`;
}

async function revert(
  app: PlayApp, observation: ReleaseObservation, previous: LifecycleState | null,
): Promise<void> {
  try {
    const where = "WHERE package_name = ? AND track = ? AND version_code = ? AND sending = 1";
    const keys = [app.packageName, observation.track, observation.versionCode];
    await (previous === null
      ? app.db.prepare(`DELETE FROM play_releases ${where}`).bind(...keys)
      : app.db.prepare(`UPDATE play_releases SET state = ?, sending = 0, previous_state = NULL ${where}`)
        .bind(previous, ...keys)).run();
  } catch (error) {
    console.error("Play sending 되돌리기 실패", error instanceof Error ? error.message : "unknown");
  }
}

// 출시노트는 edit을 열어야 읽힌다. edit은 커밋하지 않고 지운다. 같은 서비스 계정으로 진행 중인 업로드의
// edit을 무효화하지 않도록 업로드가 끝난 뒤에 나가는 internal 배포 알림에서만 읽는다. 조회가 실패해도 알림은 보낸다.
async function fetchReleaseNotes(
  google: (url: string, init?: RequestInit) => Promise<unknown>, observation: ReleaseObservation,
): Promise<ReleaseNote[]> {
  const editsUrl = `${API_BASE}/applications/${encodeURIComponent(observation.packageName)}/edits`;
  try {
    const edit = await google(editsUrl, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }) as { id?: unknown };
    if (typeof edit.id !== "string" || !edit.id) throw new Error("edit 응답에 id가 없습니다.");
    const editUrl = `${editsUrl}/${encodeURIComponent(edit.id)}`;
    try {
      return parseEditTrackReleaseNotes(
        await google(`${editUrl}/tracks/${encodeURIComponent(observation.track)}`), observation.versionCode,
      );
    } finally {
      // 지우기 실패가 읽은 출시노트를 덮지 않게 한다. 남은 edit은 Play가 만료시킨다.
      await google(editUrl, { method: "DELETE" }).catch((error: unknown) => {
        console.warn(`${observation.packageName} edit 삭제 실패:`, error instanceof Error ? error.message : error);
      });
    }
  } catch (error) {
    console.warn(`${observation.packageName} ${observation.versionCode} 출시노트 조회 실패:`,
      error instanceof Error ? error.message : error);
    return [];
  }
}

async function sendDiscord(webhookUrl: string, content: string, fetcher: typeof fetch): Promise<void> {
  if (!validDiscordWebhook(webhookUrl)) throw new Error("Invalid Discord endpoint");
  const url = new URL(webhookUrl);
  url.searchParams.set("wait", "true");
  const response = await fetcher(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: fitDiscordContent(content), allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status >= 400 && response.status < 500) throw new DiscordRejected(response.status);
  if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
}

function validDiscordWebhook(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "discord.com" && url.pathname.startsWith("/api/webhooks/");
  } catch {
    return false;
  }
}

// Discord content는 2000자를 넘으면 4xx로 거절돼 매 실행 되돌리고 재시도하게 된다. 코드 포인트 단위로 자른다.
const DISCORD_CONTENT_LIMIT = 2000;
function fitDiscordContent(content: string): string {
  const characters = Array.from(content);
  return characters.length <= DISCORD_CONTENT_LIMIT
    ? content
    : `${characters.slice(0, DISCORD_CONTENT_LIMIT - 1).join("")}…`;
}

/** Discord가 요청을 받고 4xx로 거절했다. 메시지는 게시되지 않았다. */
class DiscordRejected extends Error {
  constructor(status: number) {
    super(`Discord HTTP ${status}`);
  }
}

type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

async function runPoll(env: PlayReleaseWorkerEnv): Promise<void> {
  try {
    const result = await pollPlayReleaseWorker(env);
    console.log(`Play checked=${result.checked} notifications=${result.notifications} skipped=${result.skipped}`);
  } catch (error) {
    const details = error instanceof AggregateError
      ? error.errors.map((item) => item instanceof Error ? item.message : String(item)).join("; ")
      : "";
    console.error("Play poll failed", error instanceof Error ? error.message : "unknown", details);
    throw error;
  }
}

export default {
  async scheduled(_controller: unknown, env: PlayReleaseWorkerEnv, ctx: WaitUntil) {
    ctx.waitUntil(runPoll(env));
  },
  // HTTP 진입점은 없다. workers_dev도 끈다.
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
};
