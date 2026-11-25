import { sign } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface TestFlightAppConfig {
  appStoreId: string;
  appName: string;
  label: string;
  discordWebhookEnv: string;
}

export interface TestFlightConfig {
  pollIntervalSeconds: number;
  stateFile: string;
  apps: TestFlightAppConfig[];
}

export interface TestFlightBuild {
  id: string;
  buildNumber: string;
  version: string;
  processingState: string;
  uploadedDate: string;
}

export interface BetaBuildNote {
  locale: string;
  whatsNew: string;
}

export interface TestFlightClient {
  listBuilds(appStoreId: string): Promise<TestFlightBuild[]>;
  getNotes(buildId: string): Promise<BetaBuildNote[]>;
}

export type AppleCredentials =
  | { type: "team"; keyId: string; issuerId: string; keyPath: string }
  | { type: "individual"; keyId: string; keyPath: string };

interface AppState {
  initialized: boolean;
  seen: Record<string, string>;
}

interface State {
  version: 1;
  apps: Record<string, AppState>;
}

const API_ORIGIN = "https://api.appstoreconnect.apple.com";
const REQUEST_TIMEOUT_MS = 15_000;
const BUILD_LIMIT = 50;

export async function loadTestFlightConfig(path: string): Promise<TestFlightConfig> {
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  const interval = raw.pollIntervalSeconds ?? 300;
  if (!Number.isInteger(interval) || (interval as number) < 60) {
    throw new Error("pollIntervalSeconds는 60 이상의 정수여야 합니다.");
  }
  if (typeof raw.stateFile !== "string" || !raw.stateFile.trim()) {
    throw new Error("stateFile이 필요합니다.");
  }
  if (!Array.isArray(raw.apps) || raw.apps.length === 0) {
    throw new Error("apps에는 앱이 하나 이상 필요합니다.");
  }
  const apps = raw.apps.map((value, index) => parseApp(value, index));
  if (new Set(apps.map((app) => app.appStoreId)).size !== apps.length) {
    throw new Error("apps에 같은 appStoreId가 중복되었습니다.");
  }
  return { pollIntervalSeconds: interval as number, stateFile: raw.stateFile, apps };
}

function parseApp(value: unknown, index: number): TestFlightAppConfig {
  const app = (value ?? {}) as Record<string, unknown>;
  if (typeof app.appStoreId !== "string" || !/^\d+$/.test(app.appStoreId)) {
    throw new Error(`apps[${index}].appStoreId는 숫자 문자열이어야 합니다.`);
  }
  for (const key of ["appName", "label"] as const) {
    if (typeof app[key] !== "string" || !(app[key] as string).trim()) {
      throw new Error(`apps[${index}].${key}가 필요합니다.`);
    }
  }
  if (typeof app.discordWebhookEnv !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(app.discordWebhookEnv)) {
    throw new Error(`apps[${index}].discordWebhookEnv가 올바른 환경 변수 이름이 아닙니다.`);
  }
  return {
    appStoreId: app.appStoreId,
    appName: app.appName as string,
    label: app.label as string,
    discordWebhookEnv: app.discordWebhookEnv,
  };
}

export function appleCredentialsFromEnv(environment = process.env): AppleCredentials {
  const type = environment.APP_STORE_CONNECT_KEY_TYPE ?? "team";
  const keyId = environment.APP_STORE_CONNECT_KEY_ID;
  const keyPath = environment.APP_STORE_CONNECT_KEY_PATH;
  if (!keyId || !keyPath) throw new Error("APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_KEY_PATH가 필요합니다.");
  if (type === "individual") return { type, keyId, keyPath };
  if (type !== "team") throw new Error("APP_STORE_CONNECT_KEY_TYPE은 team 또는 individual이어야 합니다.");
  const issuerId = environment.APP_STORE_CONNECT_ISSUER_ID;
  if (!issuerId) throw new Error("팀 키에는 APP_STORE_CONNECT_ISSUER_ID가 필요합니다.");
  return { type, keyId, issuerId, keyPath };
}

export function appleToken(credentials: AppleCredentials, privateKey: string, now = Date.now()): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issued = Math.floor(now / 1000);
  // 팀 키는 iss(Issuer ID), 개인 키는 sub: "user"로 서명한다. 두 형식을 섞으면 401이 난다.
  const subject = credentials.type === "team" ? { iss: credentials.issuerId } : { sub: "user" };
  const unsigned = `${encode({ alg: "ES256", kid: credentials.keyId, typ: "JWT" })}.${encode({
    ...subject, iat: issued, exp: issued + 1200, aud: "appstoreconnect-v1",
  })}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: privateKey, dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${unsigned}.${signature}`;
}

export async function createTestFlightClient(
  credentials: AppleCredentials,
  fetcher: typeof fetch = fetch,
): Promise<TestFlightClient> {
  if (!/^[A-Za-z0-9]+$/.test(credentials.keyId) ||
      (credentials.type === "team" && !/^[0-9a-fA-F-]{36}$/.test(credentials.issuerId))) {
    throw new Error("Apple 키 ID 또는 Issuer ID가 올바르지 않습니다.");
  }
  const privateKey = await readFile(credentials.keyPath, "utf8");
  const get = async (url: URL): Promise<unknown> => {
    const response = await fetcher(url, {
      headers: {
        authorization: `Bearer ${appleToken(credentials, privateKey)}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`App Store Connect 조회 실패: HTTP ${response.status} ${url.pathname}`);
    return response.json();
  };

  return {
    async listBuilds(appStoreId) {
      const url = new URL("/v1/builds", API_ORIGIN);
      url.searchParams.set("filter[app]", appStoreId);
      url.searchParams.set("sort", "-uploadedDate");
      url.searchParams.set("limit", String(BUILD_LIMIT));
      url.searchParams.set("include", "preReleaseVersion");
      url.searchParams.set("fields[builds]", "version,uploadedDate,processingState,preReleaseVersion");
      url.searchParams.set("fields[preReleaseVersions]", "version");
      return parseBuilds(await get(url));
    },
    async getNotes(buildId) {
      const url = new URL(`/v1/builds/${encodeURIComponent(buildId)}/betaBuildLocalizations`, API_ORIGIN);
      url.searchParams.set("fields[betaBuildLocalizations]", "locale,whatsNew");
      const page = await get(url) as { data?: Array<{ attributes?: { locale?: unknown; whatsNew?: unknown } }> };
      if (!Array.isArray(page.data)) throw new Error("betaBuildLocalizations 응답에 data 배열이 없습니다.");
      return page.data.flatMap((item) => {
        const locale = item.attributes?.locale;
        const whatsNew = item.attributes?.whatsNew;
        return typeof locale === "string" && typeof whatsNew === "string" ? [{ locale, whatsNew }] : [];
      });
    },
  };
}

export function parseBuilds(body: unknown): TestFlightBuild[] {
  const page = body as {
    data?: Array<{
      id?: string;
      attributes?: { version?: string; uploadedDate?: string; processingState?: string };
      relationships?: { preReleaseVersion?: { data?: { id?: string } | null } };
    }>;
    included?: Array<{ type?: string; id?: string; attributes?: { version?: string } }>;
  };
  if (!Array.isArray(page.data)) throw new Error("builds 응답에 data 배열이 없습니다.");
  const versions = new Map(
    (page.included ?? [])
      .filter((item) => item.type === "preReleaseVersions" && item.id && item.attributes?.version)
      .map((item) => [item.id!, item.attributes!.version!]),
  );
  return page.data.map((item) => {
    const attributes = item.attributes;
    if (!item.id || !attributes?.version || !attributes.processingState || !attributes.uploadedDate) {
      throw new Error("builds 응답에 필수 필드가 없습니다.");
    }
    const versionId = item.relationships?.preReleaseVersion?.data?.id;
    return {
      id: item.id,
      buildNumber: attributes.version,
      version: (versionId && versions.get(versionId)) || "?",
      processingState: attributes.processingState,
      uploadedDate: attributes.uploadedDate,
    };
  });
}

export function formatTestFlightMessage(
  app: Pick<TestFlightAppConfig, "appName" | "label">,
  build: Pick<TestFlightBuild, "version" | "buildNumber">,
  notes: BetaBuildNote[],
): string {
  const lines = [
    "[App Store Release Review Ping] 🧪 TestFlight 새 빌드 배포",
    `${app.appName} ${app.label} · TestFlight`,
    `버전 ${build.version} (${build.buildNumber})`,
  ];
  const note = pickNote(notes);
  if (note) {
    // Discord content는 2000자까지다. whatsNew는 4000자까지 가능해, 자르지 않으면 전송이 영구히 실패한다.
    const header = [...lines, "", "업데이트노트", ""].join("\n");
    const room = DISCORD_CONTENT_LIMIT - header.length;
    lines.push("", "업데이트노트", note.length > room ? `${note.slice(0, room - 1)}…` : note);
  }
  return lines.join("\n");
}

const DISCORD_CONTENT_LIMIT = 2000;

function pickNote(notes: BetaBuildNote[]): string | undefined {
  const usable = notes
    .map((note) => ({ locale: note.locale, text: note.whatsNew.trim() }))
    .filter((note) => note.text);
  return (usable.find((note) => note.locale === "ko" || note.locale.startsWith("ko-")) ?? usable[0])?.text;
}

export async function pollTestFlightOnce(
  config: TestFlightConfig,
  client: TestFlightClient,
  send: (app: TestFlightAppConfig, message: string) => Promise<void>,
): Promise<{ checked: number; notifications: number; baselines: number }> {
  const state = await readState(config.stateFile);
  let checked = 0;
  let notifications = 0;
  let baselines = 0;
  const errors: unknown[] = [];
  // 앱 하나의 조회·전송 실패가 다른 앱 알림을 막지 않도록 앱별로 처리하고, 실패는 끝에서 모아 던진다.
  for (const app of config.apps) {
    try {
      const result = await pollApp(config, state, app, client, send);
      checked += result.checked;
      notifications += result.notifications;
      baselines += result.baseline ? 1 : 0;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `TestFlight 조회 실패 ${errors.length}건 (알림 ${notifications}건 전송)`);
  }
  return { checked, notifications, baselines };
}

async function pollApp(
  config: TestFlightConfig,
  state: State,
  app: TestFlightAppConfig,
  client: TestFlightClient,
  send: (app: TestFlightAppConfig, message: string) => Promise<void>,
): Promise<{ checked: number; notifications: number; baseline: boolean }> {
  const builds = await client.listBuilds(app.appStoreId);
  const appState = state.apps[app.appStoreId] ??= { initialized: false, seen: {} };
  if (!appState.initialized) {
    // 처리 중인 빌드는 기준점에 넣지 않는다. 넣으면 처리가 끝나도 알림 없이 묻힌다.
    for (const build of builds) {
      if (build.processingState !== "PROCESSING") appState.seen[build.id] = build.processingState;
    }
    appState.initialized = true;
    await saveState(config.stateFile, state);
    return { checked: builds.length, notifications: 0, baseline: true };
  }
  let notifications = 0;
  for (const build of [...builds].reverse()) {
    if (appState.seen[build.id] || build.processingState === "PROCESSING") continue;
    if (build.processingState === "VALID") {
      const notes = await fetchNotes(client, build);
      await send(app, formatTestFlightMessage(app, build, notes));
      notifications++;
    }
    appState.seen[build.id] = build.processingState;
    await saveState(config.stateFile, state);
  }
  return { checked: builds.length, notifications, baseline: false };
}

// 업데이트노트 조회가 실패해도 빌드 알림은 보낸다.
export async function fetchNotes(client: TestFlightClient, build: TestFlightBuild): Promise<BetaBuildNote[]> {
  try {
    return await client.getNotes(build.id);
  } catch (error) {
    console.warn(`${build.version} (${build.buildNumber}) 업데이트노트 조회 실패:`,
      error instanceof Error ? error.message : error);
    return [];
  }
}

async function readState(path: string): Promise<State> {
  try {
    const state = JSON.parse(await readFile(path, "utf8")) as State;
    if (state.version !== 1 || !state.apps || typeof state.apps !== "object") {
      throw new Error("TestFlight 상태 파일 형식이 올바르지 않습니다.");
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, apps: {} };
    throw error;
  }
}

async function saveState(path: string, state: State): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
