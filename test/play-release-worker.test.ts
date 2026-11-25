import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { parsePlayApps, pollPlayReleaseWorker, type PlayReleaseWorkerEnv } from "../src/play-release-worker.js";
import { exportState, seedSql } from "../src/play-state-cli.js";

// node:sqlite를 D1 API 모양으로 감싼다. 실제 마이그레이션 SQL을 그대로 적용한다.
async function d1(counter: { queries: number }) {
  const db = new DatabaseSync(":memory:");
  db.exec(await readFile("migrations/0003_play_releases.sql", "utf8"));
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...values: unknown[]) => statement(sql, values),
    async first<T>() { counter.queries++; return (db.prepare(sql).get(...(args as never[])) ?? null) as T | null; },
    async all<T>() { counter.queries++; return { results: db.prepare(sql).all(...(args as never[])) as T[] }; },
    async run() { counter.queries++; return { meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }; },
  });
  return { raw: db, prepare: (sql: string) => statement(sql) };
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PUBLISHED = "RELEASE_LIFECYCLE_STATE_PUBLISHED";
const IN_REVIEW = "RELEASE_LIFECYCLE_STATE_IN_REVIEW";
const APPROVED = "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED";

function serviceAccount(name: string): string {
  return JSON.stringify({
    type: "service_account",
    client_email: `${name}@example.iam.gserviceaccount.com`,
    private_key: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  });
}

// 앱별 오류는 AggregateError로 모아 던진다. 안의 메시지로 확인한다.
async function rejectsWith(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors.map((item: Error) => item.message).join("\n"), pattern);
    return true;
  });
}

type Release = { name: string; versionCodes: number[]; state: string };

async function fixture(options: { discordStatus?: number; notesStatus?: number } = {}) {
  const tracks: Record<string, Release[]> = { internal: [], production: [] };
  const sent: string[] = [];
  const calls: string[] = [];
  const counter = { queries: 0 };
  const db = await d1(counter);
  const state = { discordStatus: options.discordStatus ?? 200, notesStatus: options.notesStatus ?? 200 };
  const env: PlayReleaseWorkerEnv = {
    PLAY_APPS: JSON.stringify([{ key: "YEOBEE", packageName: "com.yeobee", tracks: ["internal", "production"] }]),
    YEOBEE_DB: db,
    YEOBEE_GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccount("yeobee"),
    YEOBEE_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/yeobee",
  };
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "ya29.test" });
    if (url.hostname === "discord.com") {
      const body = JSON.parse(String(init?.body)) as { content: string; allowed_mentions: unknown };
      assert.deepEqual(body.allowed_mentions, { parse: [] });
      assert.equal(url.searchParams.get("wait"), "true");
      if (state.discordStatus === 200) sent.push(body.content);
      return new Response("{}", { status: state.discordStatus });
    }
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer ya29.test");
    const path = url.pathname.replace("/androidpublisher/v3/applications/com.yeobee", "");
    calls.push(`${method} ${path}`);
    const releaseList = path.match(/^\/tracks\/([^/]+)\/releases$/);
    if (releaseList) {
      return Response.json({
        releases: tracks[releaseList[1]].map((release) => ({
          releaseName: release.name, track: releaseList[1], releaseLifecycleState: release.state,
          activeArtifacts: release.versionCodes.map((versionCode) => ({ versionCode })),
        })),
      });
    }
    if (method === "POST" && path === "/edits") return Response.json({ id: "edit-1" });
    if (method === "GET" && path === "/edits/edit-1/tracks/internal") {
      return Response.json({
        releases: tracks.internal.map((release) => ({
          versionCodes: release.versionCodes.map(String),
          releaseNotes: [{ language: "en-US", text: "fix" }, { language: "ko-KR", text: "정산 누락 수정" }],
        })),
      }, { status: state.notesStatus });
    }
    if (method === "DELETE" && path === "/edits/edit-1") return new Response(null, { status: 204 });
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  return { env, fetcher, tracks, sent, calls, counter, db: db.raw, state };
}

function rows(db: DatabaseSync) {
  return db.prepare("SELECT track, version_code, state, sending FROM play_releases ORDER BY track, version_code").all()
    .map((row) => ({ ...row }));
}

test("첫 실행은 기준점만 저장하고 알리지 않는다", async () => {
  const f = await fixture();
  f.tracks.internal = [{ name: "1.4.0", versionCodes: [10400], state: PUBLISHED }];
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: IN_REVIEW }];
  assert.deepEqual(await pollPlayReleaseWorker(f.env, f.fetcher), { checked: 2, notifications: 0, skipped: 0 });
  assert.equal(f.sent.length, 0);
  assert.equal(rows(f.db).length, 2);
  assert.ok(f.counter.queries <= 10);
  assert.ok(!f.calls.some((call) => call.includes("/edits")));
});

test("심사 상태가 바뀌면 한 번만 알리고, 같은 상태는 다시 보내지 않는다", async () => {
  const f = await fixture();
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: IN_REVIEW }];
  await pollPlayReleaseWorker(f.env, f.fetcher);
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: APPROVED }];
  assert.equal((await pollPlayReleaseWorker(f.env, f.fetcher)).notifications, 1);
  assert.equal((await pollPlayReleaseWorker(f.env, f.fetcher)).notifications, 0);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /심사 승인 완료/);
  assert.match(f.sent[0], /IN_REVIEW → APPROVED_NOT_PUBLISHED/);
  assert.deepEqual(rows(f.db), [{ track: "production", version_code: 10400, state: APPROVED, sending: 0 }]);
});

test("기준점이 있는 internal 트랙에 새 버전이 게시되면 출시노트(ko-KR)와 함께 알리고 edit은 지운다", async () => {
  const f = await fixture();
  f.tracks.internal = [{ name: "1.4.0", versionCodes: [10400], state: PUBLISHED }];
  await pollPlayReleaseWorker(f.env, f.fetcher);
  f.tracks.internal = [{ name: "1.4.1", versionCodes: [10401], state: PUBLISHED }];
  f.calls.length = 0;
  assert.equal((await pollPlayReleaseWorker(f.env, f.fetcher)).notifications, 1);
  assert.match(f.sent[0], /Internal Testing 새 버전 배포/);
  assert.match(f.sent[0], /버전 1\.4\.1 \(10401\)/);
  assert.match(f.sent[0], /출시노트\n정산 누락 수정$/);
  assert.deepEqual(f.calls.filter((call) => call.includes("/edits")),
    ["POST /edits", "GET /edits/edit-1/tracks/internal", "DELETE /edits/edit-1"]);
  assert.ok(!f.calls.some((call) => call.includes(":commit")));
});

test("기준점이 없는 트랙의 첫 게시는 알리지 않는다 (로컬 poller와 같음)", async () => {
  const f = await fixture();
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: PUBLISHED }];
  await pollPlayReleaseWorker(f.env, f.fetcher);
  f.tracks.internal = [{ name: "1.4.1", versionCodes: [10401], state: PUBLISHED }];
  assert.equal((await pollPlayReleaseWorker(f.env, f.fetcher)).notifications, 0);
  assert.equal(f.sent.length, 0);
});

test("출시노트 조회가 실패해도 노트 없이 알린다", async () => {
  const f = await fixture({ notesStatus: 500 });
  f.tracks.internal = [{ name: "1.4.0", versionCodes: [10400], state: PUBLISHED }];
  await pollPlayReleaseWorker(f.env, f.fetcher);
  f.tracks.internal = [{ name: "1.4.1", versionCodes: [10401], state: PUBLISHED }];
  assert.equal((await pollPlayReleaseWorker(f.env, f.fetcher)).notifications, 1);
  assert.doesNotMatch(f.sent[0], /출시노트/);
  assert.ok(f.calls.includes("DELETE /edits/edit-1"));
});

test("Discord가 4xx(429 포함)로 거절하면 이전 상태로 되돌려 다음 실행에서 한 번 다시 보낸다", async () => {
  const f = await fixture();
  f.tracks.internal = [{ name: "1.4.0", versionCodes: [10400], state: PUBLISHED }];
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: IN_REVIEW }];
  await pollPlayReleaseWorker(f.env, f.fetcher);
  f.tracks.internal = [{ name: "1.4.1", versionCodes: [10401], state: PUBLISHED }];
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: APPROVED }];
  f.state.discordStatus = 429;
  await rejectsWith(pollPlayReleaseWorker(f.env, f.fetcher), /com\.yeobee: Discord 전송 실패 2건.*internal\/10401: Discord HTTP 429; production\/10400: Discord HTTP 429/);
  // 처음 본 versionCode는 행을 지우고, 기존 versionCode는 이전 상태로 되돌린다.
  assert.deepEqual(rows(f.db), [
    { track: "internal", version_code: 10400, state: PUBLISHED, sending: 0 },
    { track: "production", version_code: 10400, state: IN_REVIEW, sending: 0 },
  ]);
  f.state.discordStatus = 200;
  assert.equal((await pollPlayReleaseWorker(f.env, f.fetcher)).notifications, 2);
  assert.equal((await pollPlayReleaseWorker(f.env, f.fetcher)).notifications, 0);
  assert.equal(f.sent.length, 2);
});

test("Discord 5xx·타임아웃은 게시됐을 수 있어 다시 보내지 않는다 (sending 유지)", async () => {
  const f = await fixture();
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: IN_REVIEW }];
  await pollPlayReleaseWorker(f.env, f.fetcher);
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: APPROVED }];
  f.state.discordStatus = 502;
  await rejectsWith(pollPlayReleaseWorker(f.env, f.fetcher), /Discord HTTP 502/);
  f.state.discordStatus = 200;
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try {
    assert.equal((await pollPlayReleaseWorker(f.env, f.fetcher)).notifications, 0);
  } finally {
    console.warn = original;
  }
  assert.equal(f.sent.length, 0);
  assert.match(warnings.join("\n"), /sending=1\): production\/10400=RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED/);
  // 상태가 다시 바뀌면 그 전환은 정상으로 알리고 sending 표시를 지운다.
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: PUBLISHED }];
  console.warn = () => {};
  try {
    assert.equal((await pollPlayReleaseWorker(f.env, f.fetcher)).notifications, 1);
  } finally {
    console.warn = original;
  }
  assert.deepEqual(rows(f.db), [{ track: "production", version_code: 10400, state: PUBLISHED, sending: 0 }]);
});

test("다른 실행이 lease를 잡고 있으면 건너뛰고, 끝난 실행은 lease를 푼다", async () => {
  const f = await fixture();
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: IN_REVIEW }];
  await pollPlayReleaseWorker(f.env, f.fetcher);
  assert.deepEqual({ ...f.db.prepare("SELECT lease_until, lease_token FROM play_apps").get() }, { lease_until: 0, lease_token: "" });
  f.db.prepare("UPDATE play_apps SET lease_until = ?, lease_token = 'other'").run(Date.now() + 60_000);
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: APPROVED }];
  assert.deepEqual(await pollPlayReleaseWorker(f.env, f.fetcher), { checked: 0, notifications: 0, skipped: 1 });
  assert.equal(f.sent.length, 0);
  f.db.prepare("UPDATE play_apps SET lease_until = 0").run();
  assert.equal((await pollPlayReleaseWorker(f.env, f.fetcher)).notifications, 1);
});

test("한 응답에 같은 versionCode가 두 번 나와도 한 번만 처리한다", async () => {
  const f = await fixture();
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: IN_REVIEW }];
  await pollPlayReleaseWorker(f.env, f.fetcher);
  f.tracks.production = [
    { name: "1.4.0", versionCodes: [10400], state: APPROVED },
    { name: "1.4.0", versionCodes: [10400], state: PUBLISHED },
  ];
  assert.equal((await pollPlayReleaseWorker(f.env, f.fetcher)).notifications, 1);
  assert.equal(f.sent.length, 1);
});

test("로컬 상태 파일로 seed하면 같은 상태는 알리지 않고 이후 전환만 알린다", async () => {
  const f = await fixture();
  const local = {
    version: 1,
    observations: {
      "com.yeobee|internal|10400": { state: PUBLISHED, releaseName: "1.4.0", observedAt: "2026-11-25T08:06:11.050Z" },
      "com.yeobee|production|10400": { state: IN_REVIEW, releaseName: "1.4.0", observedAt: "2026-11-25T08:06:11.050Z" },
      "com.other|production|1": { state: PUBLISHED, releaseName: "o'1", observedAt: "2026-11-25T08:06:11.050Z" },
    },
  };
  f.db.exec(seedSql(local, "com.yeobee"));
  assert.throws(() => f.db.exec(seedSql(local, "com.yeobee")), /UNIQUE/);
  f.tracks.internal = [{ name: "1.4.0", versionCodes: [10400], state: PUBLISHED }];
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: IN_REVIEW }];
  assert.equal((await pollPlayReleaseWorker(f.env, f.fetcher)).notifications, 0);
  f.tracks.internal = [{ name: "1.4.1", versionCodes: [10401], state: PUBLISHED }];
  assert.equal((await pollPlayReleaseWorker(f.env, f.fetcher)).notifications, 1);

  const exported = exportState([{ results: f.db.prepare("SELECT * FROM play_releases").all() }], "com.yeobee");
  assert.deepEqual(Object.keys(exported.observations).sort(),
    ["com.yeobee|internal|10400", "com.yeobee|internal|10401", "com.yeobee|production|10400"]);
  assert.equal(exported.observations["com.yeobee|internal|10400"].observedAt, "2026-11-25T08:06:11.050Z");
});

test("전송이 실패해도 같은 실행의 알림 없는 관측은 저장해, 다음 전환을 놓치지 않는다", async () => {
  const f = await fixture();
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: IN_REVIEW }];
  await pollPlayReleaseWorker(f.env, f.fetcher);
  // 10400 승인 알림은 Discord 404로 실패하고, 같은 실행에서 처음 보인 10401 IN_REVIEW는 저장돼야 한다.
  f.tracks.production = [
    { name: "1.4.0", versionCodes: [10400], state: APPROVED },
    { name: "1.4.1", versionCodes: [10401], state: IN_REVIEW },
  ];
  f.state.discordStatus = 404;
  await rejectsWith(pollPlayReleaseWorker(f.env, f.fetcher), /production\/10400: Discord HTTP 404/);
  assert.deepEqual(rows(f.db), [
    { track: "production", version_code: 10400, state: IN_REVIEW, sending: 0 },
    { track: "production", version_code: 10401, state: IN_REVIEW, sending: 0 },
  ]);
  f.state.discordStatus = 200;
  f.tracks.production = [
    { name: "1.4.0", versionCodes: [10400], state: APPROVED },
    { name: "1.4.1", versionCodes: [10401], state: APPROVED },
  ];
  assert.equal((await pollPlayReleaseWorker(f.env, f.fetcher)).notifications, 2);
  assert.equal(f.sent.length, 2);
});

test("Discord 웹훅 주소가 잘못되면 lease·D1을 건드리기 전에 그 앱만 실패한다", async () => {
  const f = await fixture();
  f.env.YEOBEE_DISCORD_WEBHOOK_URL = "\"https://discord.com/api/webhooks/1/x\"";
  await rejectsWith(pollPlayReleaseWorker(f.env, f.fetcher), /YEOBEE_DISCORD_WEBHOOK_URL이 https:\/\/discord\.com/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM play_apps").get()?.n, 0);
  assert.equal(rows(f.db).length, 0);
});

test("2000자를 넘는 메시지는 Discord 한도에 맞게 코드 포인트 단위로 자른다", async () => {
  const f = await fixture();
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: IN_REVIEW }];
  await pollPlayReleaseWorker(f.env, f.fetcher);
  f.tracks.production = [{ name: "😀".repeat(2100), versionCodes: [10400], state: APPROVED }];
  assert.equal((await pollPlayReleaseWorker(f.env, f.fetcher)).notifications, 1);
  const characters = Array.from(f.sent[0]);
  assert.equal(characters.length, 2000);
  assert.equal(characters.at(-1), "…");
  assert.equal(characters.at(-2), "😀");
});

test("PLAY_APPS 형식이 틀리면 실행하지 않는다", () => {
  assert.throws(() => parsePlayApps("x"), /JSON 배열/);
  assert.throws(() => parsePlayApps("[]"), /하나 이상/);
  assert.throws(() => parsePlayApps(JSON.stringify([{ key: "yeobee", packageName: "a", tracks: ["internal"] }])), /key/);
  assert.throws(() => parsePlayApps(JSON.stringify([{ key: "A", packageName: "a", tracks: [] }])), /tracks/);
  assert.throws(() => parsePlayApps(JSON.stringify([
    { key: "A", packageName: "a", tracks: ["internal"] }, { key: "A", packageName: "b", tracks: ["internal"] },
  ])), /중복/);
  assert.deepEqual(parsePlayApps(JSON.stringify([{ key: "A", packageName: "a", tracks: ["internal", "internal"] }])),
    [{ key: "A", packageName: "a", tracks: ["internal"] }]);
});

test("앱별 서비스 계정·웹훅·D1을 쓰고, 한 앱이 실패해도 다른 앱은 알린다", async () => {
  const counter = { queries: 0 };
  const yeobee = await d1(counter);
  const bandalart = await d1(counter);
  const tokenRequests: string[] = [];
  const posted: Array<{ hook: string; content: string }> = [];
  const releases: Record<string, string> = { "com.yeobee": IN_REVIEW, "com.nexters.bandalart": IN_REVIEW };
  let failYeobeeToken = false;
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") {
      const assertion = new URLSearchParams(String(init?.body)).get("assertion")!;
      const email = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString()).iss as string;
      tokenRequests.push(email);
      if (failYeobeeToken && email.startsWith("yeobee")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: `token-${email.split("@")[0]}` });
    }
    if (url.hostname === "discord.com") {
      posted.push({ hook: url.pathname, content: JSON.parse(String(init?.body)).content });
      return new Response("{}", { status: 200 });
    }
    const packageName = url.pathname.split("/")[4];
    const expected = packageName === "com.yeobee" ? "Bearer token-yeobee" : "Bearer token-bandalart";
    assert.equal((init?.headers as Record<string, string>).authorization, expected);
    const track = url.pathname.split("/")[6];
    return Response.json({
      releases: track === "production"
        ? [{ releaseName: "1.0", track, releaseLifecycleState: releases[packageName], activeArtifacts: [{ versionCode: 1 }] }]
        : [],
    });
  }) as typeof fetch;
  const env: PlayReleaseWorkerEnv = {
    PLAY_APPS: JSON.stringify([
      { key: "YEOBEE", packageName: "com.yeobee", tracks: ["internal", "production"] },
      { key: "BANDALART", packageName: "com.nexters.bandalart", tracks: ["internal", "production"] },
    ]),
    YEOBEE_DB: yeobee,
    YEOBEE_GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccount("yeobee"),
    YEOBEE_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/yeobee",
    BANDALART_DB: bandalart,
    BANDALART_GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccount("bandalart"),
    BANDALART_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/2/bandalart",
  };
  assert.deepEqual(await pollPlayReleaseWorker(env, fetcher), { checked: 2, notifications: 0, skipped: 0 });
  assert.deepEqual(yeobee.raw.prepare("SELECT package_name FROM play_releases").all().map((row) => row.package_name), ["com.yeobee"]);
  assert.deepEqual(bandalart.raw.prepare("SELECT package_name FROM play_releases").all().map((row) => row.package_name),
    ["com.nexters.bandalart"]);

  releases["com.yeobee"] = APPROVED;
  releases["com.nexters.bandalart"] = APPROVED;
  failYeobeeToken = true;
  await rejectsWith(pollPlayReleaseWorker(env, fetcher), /com\.yeobee: Google 토큰 발급 실패: HTTP 400 invalid_grant/);
  assert.deepEqual(posted.map((item) => item.hook), ["/api/webhooks/2/bandalart"]);
  assert.match(posted[0].content, /com\.nexters\.bandalart · production/);
  // 실패한 앱은 lease를 풀어 다음 Cron에서 바로 다시 조회한다.
  assert.equal(yeobee.raw.prepare("SELECT lease_until FROM play_apps").get()?.lease_until, 0);

  failYeobeeToken = false;
  assert.equal((await pollPlayReleaseWorker(env, fetcher)).notifications, 1);
  assert.deepEqual(posted.map((item) => item.hook), ["/api/webhooks/2/bandalart", "/api/webhooks/1/yeobee"]);
  assert.ok(counter.queries < 50 * 3);

  // 한 앱의 비밀값이 빠져도 다른 앱은 조회한다.
  delete env.YEOBEE_DISCORD_WEBHOOK_URL;
  releases["com.nexters.bandalart"] = PUBLISHED;
  await rejectsWith(pollPlayReleaseWorker(env, fetcher), /YEOBEE_DISCORD_WEBHOOK_URL/);
  assert.equal(posted.length, 3);
});

test("두 앱을 한 실행에서 처리해도 D1 쿼리는 무료 플랜 한도(50개)보다 훨씬 적다", async () => {
  const f = await fixture();
  f.tracks.internal = [{ name: "1.4.0", versionCodes: [10400], state: PUBLISHED }];
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: IN_REVIEW }];
  await pollPlayReleaseWorker(f.env, f.fetcher);
  f.tracks.internal = [{ name: "1.4.1", versionCodes: [10401], state: PUBLISHED }];
  f.tracks.production = [{ name: "1.4.0", versionCodes: [10400], state: APPROVED }];
  f.counter.queries = 0;
  assert.equal((await pollPlayReleaseWorker(f.env, f.fetcher)).notifications, 2);
  // 알림 2건인 실행이 앱당 쿼리 11개. 두 앱이면 22개.
  assert.ok(f.counter.queries <= 11, `queries=${f.counter.queries}`);
});
