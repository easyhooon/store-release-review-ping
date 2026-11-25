import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  handleBuildUploadWebhook, parseWorkerApps, pollTestFlightWorker, type TestFlightWorkerEnv,
} from "../src/testflight-worker.js";

// node:sqlite를 D1 API 모양으로 감싼다. 실제 마이그레이션 SQL을 그대로 적용한다.
async function d1(counter = { queries: 0 }): Promise<TestFlightWorkerEnv["DB"] & { raw: DatabaseSync }> {
  const db = new DatabaseSync(":memory:");
  db.exec(await readFile("migrations/0002_testflight_builds.sql", "utf8"));
  const statement = (sql: string, args: unknown[] = []) => ({
    sql,
    bind: (...values: unknown[]) => statement(sql, values),
    async first<T>() { counter.queries++; return (db.prepare(sql).get(...(args as never[])) ?? null) as T | null; },
    async all<T>() { counter.queries++; return { results: db.prepare(sql).all(...(args as never[])) as T[] }; },
    async run() { counter.queries++; return { meta: { changes: Number(db.prepare(sql).run(...(args as never[])).changes) } }; },
  });
  return {
    raw: db,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      db.exec("BEGIN");
      try { for (const item of statements) await item.run(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
      return [];
    },
  };
}

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });

async function fixture(builds: Record<string, Array<[string, string, string]>>, options: {
  notes?: unknown; notesStatus?: number; discordStatus?: number;
} = {}) {
  const sent: string[] = [];
  const counter = { queries: 0 };
  const db = await d1(counter);
  const env: TestFlightWorkerEnv = {
    DB: db,
    APPLE_WEBHOOK_SECRET: "test-shared-secret",
    APP_NAME: "여비",
    TESTFLIGHT_APPS: JSON.stringify([{ appStoreId: "1", label: "PRD" }, { appStoreId: "2", label: "DEV" }]),
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/123/test",
    APP_STORE_CONNECT_KEY_TYPE: "individual",
    APP_STORE_CONNECT_KEY_ID: "TESTKEY123",
    APP_STORE_CONNECT_PRIVATE_KEY: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "discord.com") {
      const body = JSON.parse(String(init?.body)) as { content: string; allowed_mentions: unknown };
      assert.deepEqual(body.allowed_mentions, { parse: [] });
      assert.equal(url.searchParams.get("wait"), "true");
      if ((options.discordStatus ?? 200) === 200) sent.push(body.content);
      return new Response("{}", { status: options.discordStatus ?? 200 });
    }
    assert.match(String((init?.headers as Record<string, string>).authorization), /^Bearer .+\..+\..+$/);
    if (url.pathname.endsWith("/betaBuildLocalizations")) {
      return Response.json(options.notes ?? { data: [{ attributes: { locale: "ko", whatsNew: "정산 누락 수정" } }] },
        { status: options.notesStatus ?? 200 });
    }
    assert.equal(url.pathname, "/v1/builds");
    const rows = builds[url.searchParams.get("filter[app]")!] ?? [];
    return Response.json({
      data: rows.map(([id, number, state]) => ({
        id, attributes: { version: number, uploadedDate: "2026-11-10T08:21:22-08:00", processingState: state },
        relationships: { preReleaseVersion: { data: { id: "v" } } },
      })),
      included: [{ type: "preReleaseVersions", id: "v", attributes: { version: "1.8.11" } }],
    });
  }) as typeof fetch;
  return { env, fetcher, sent, builds, db: db.raw, counter };
}

test("첫 실행은 기준점만 저장하고, 이후 VALID가 된 새 빌드만 한 번 알린다", async () => {
  const f = await fixture({ "1": [["old", "1", "VALID"], ["proc", "2", "PROCESSING"]], "2": [] });
  assert.deepEqual(await pollTestFlightWorker(f.env, f.fetcher), { notifications: 0, baselines: 2, skipped: 0 });
  assert.equal(f.sent.length, 0);

  f.builds["1"] = [["new", "3", "VALID"], ["proc", "2", "VALID"], ["old", "1", "VALID"]];
  assert.deepEqual(await pollTestFlightWorker(f.env, f.fetcher), { notifications: 2, baselines: 0, skipped: 0 });
  // 오래된 빌드부터 보낸다. 기준점 때 처리 중이던 빌드도 VALID가 되면 알린다.
  assert.match(f.sent[0]!, /버전 1\.8\.11 \(2\)/);
  assert.match(f.sent[1]!, /여비 PRD · TestFlight\n버전 1\.8\.11 \(3\)\n\n업데이트노트\n정산 누락 수정/);

  assert.deepEqual(await pollTestFlightWorker(f.env, f.fetcher), { notifications: 0, baselines: 0, skipped: 0 });
});

test("PROCESSING은 건너뛰고, INVALID 같은 실패 상태는 알리지 않고 본 것으로 기록한다", async () => {
  const f = await fixture({ "1": [], "2": [] });
  await pollTestFlightWorker(f.env, f.fetcher);
  f.builds["2"] = [["a", "1", "PROCESSING"], ["b", "2", "INVALID"]];
  assert.equal((await pollTestFlightWorker(f.env, f.fetcher)).notifications, 0);
  f.builds["2"] = [["a", "1", "VALID"], ["b", "2", "INVALID"]];
  assert.equal((await pollTestFlightWorker(f.env, f.fetcher)).notifications, 1);
  assert.match(f.sent[0]!, /여비 DEV · TestFlight/);
});

test("업데이트노트 조회가 실패해도 노트 없이 알림을 보낸다", async () => {
  const f = await fixture({ "1": [], "2": [] }, { notesStatus: 500 });
  await pollTestFlightWorker(f.env, f.fetcher);
  f.builds["1"] = [["n", "4", "VALID"]];
  assert.equal((await pollTestFlightWorker(f.env, f.fetcher)).notifications, 1);
  assert.doesNotMatch(f.sent[0]!, /업데이트노트/);
});

test("Discord가 4xx로 거절하면 기록을 지우고 다음 실행에서 다시 보낸다", async () => {
  const f = await fixture({ "1": [], "2": [] }, { discordStatus: 429 });
  await pollTestFlightWorker(f.env, f.fetcher);
  f.builds["1"] = [["n", "5", "VALID"]];
  await assert.rejects(pollTestFlightWorker(f.env, f.fetcher), /TestFlight 조회 실패 1건/);
  const retry = await fixture({}, {});
  // 같은 DB로 Discord만 복구된 상황을 만든다.
  const result = await pollTestFlightWorker({ ...f.env }, (async (input: URL | RequestInfo, init?: RequestInit) =>
    new URL(String(input)).hostname === "discord.com"
      ? (retry.sent.push("ok"), new Response("{}")) : f.fetcher(input, init)) as typeof fetch);
  assert.equal(result.notifications, 1);
  assert.equal(retry.sent.length, 1);
});

test("TESTFLIGHT_APPS 형식이 틀리면 실행하지 않는다", () => {
  assert.throws(() => parseWorkerApps("[]"), /하나 이상/);
  assert.throws(() => parseWorkerApps('[{"appStoreId":"x","label":"PRD"}]'), /숫자 문자열/);
  assert.throws(() => parseWorkerApps('[{"appStoreId":"1","label":"A"},{"appStoreId":"1","label":"B"}]'), /중복/);
});

test("기준점은 빌드가 많아도 앱당 D1 쿼리 몇 개로 저장한다 (무료 플랜 실행당 50개 한도)", async () => {
  const many = Array.from({ length: 50 }, (_, i) => [`b${i}`, String(i), "VALID"] as [string, string, string]);
  const f = await fixture({ "1": many, "2": many.map(([id, n, st]) => [`d${id}`, n, st] as [string, string, string]) });
  await pollTestFlightWorker(f.env, f.fetcher);
  assert.ok(f.counter.queries <= 10, `queries=${f.counter.queries}`);
  assert.equal((f.db.prepare("SELECT COUNT(*) n FROM testflight_builds").get() as { n: number }).n, 100);
});

test("다른 실행이 lease를 잡고 있으면 그 앱은 건너뛰고, 끝나면 lease를 푼다", async () => {
  const f = await fixture({ "1": [], "2": [] });
  await pollTestFlightWorker(f.env, f.fetcher);
  f.builds["1"] = [["n", "6", "VALID"]];
  f.db.prepare("UPDATE testflight_apps SET lease_until = ?, lease_token = 'other' WHERE app_id = '1'").run(Date.now() + 60_000);
  assert.deepEqual(await pollTestFlightWorker(f.env, f.fetcher), { notifications: 0, baselines: 0, skipped: 1 });
  f.db.prepare("UPDATE testflight_apps SET lease_until = 0, lease_token = '' WHERE app_id = '1'").run();
  assert.equal((await pollTestFlightWorker(f.env, f.fetcher)).notifications, 1);
  const row = f.db.prepare("SELECT lease_until, lease_token FROM testflight_apps WHERE app_id = '1'").get();
  assert.deepEqual({ ...row }, { lease_until: 0, lease_token: "" });
});

function signed(body: string, secret = "test-shared-secret", path = "/apple/build-upload"): Request {
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return new Request(`https://worker.example${path}`, {
    method: "POST", body, headers: { "x-apple-signature": `hmacsha256=${signature}` },
  });
}

const complete = JSON.stringify({ data: {
  type: "buildUploadStateUpdated", id: "7c813492-9516-4c79-903e-224effdd57ac", version: 1,
  attributes: { newState: "COMPLETE" },
  relationships: { instance: { data: { type: "buildUploads", id: "ad7e6298-2570-4ca6-b3cc-f81788e40bdc" } } },
} });

test("서명된 업로드 COMPLETE 웹훅은 202로 받고 바로 조회해 VALID 빌드를 알린다", async () => {
  const f = await fixture({ "1": [], "2": [] });
  await pollTestFlightWorker(f.env, f.fetcher);
  f.builds["1"] = [["w", "7", "VALID"]];
  const pending: Promise<unknown>[] = [];
  const response = await handleBuildUploadWebhook(signed(complete), f.env, { waitUntil: (p) => pending.push(p) }, f.fetcher);
  assert.equal(response.status, 202);
  await Promise.all(pending);
  assert.equal(f.sent.length, 1);
});

test("서명이 틀리거나 COMPLETE가 아닌 웹훅은 조회하지 않는다", async () => {
  const f = await fixture({ "1": [], "2": [] });
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };
  assert.equal((await handleBuildUploadWebhook(signed(complete, "wrong"), f.env, ctx, f.fetcher)).status, 401);
  const processing = complete.replace("COMPLETE", "PROCESSING");
  assert.equal((await handleBuildUploadWebhook(signed(processing), f.env, ctx, f.fetcher)).status, 204);
  const ping = JSON.stringify({ data: { type: "webhookPingCreated", id: "x" } });
  assert.equal((await handleBuildUploadWebhook(signed(ping), f.env, ctx, f.fetcher)).status, 204);
  assert.equal((await handleBuildUploadWebhook(signed(complete, undefined, "/other"), f.env, ctx, f.fetcher)).status, 404);
  assert.equal(pending.length, 0);
});

test("만료된 lease는 다시 잡고, 실행 중 lease를 뺏기면 남은 빌드를 보내지 않는다", async () => {
  const f = await fixture({ "1": [], "2": [] });
  await pollTestFlightWorker(f.env, f.fetcher);
  f.db.prepare("UPDATE testflight_apps SET lease_until = 1, lease_token = 'crashed' WHERE app_id = '1'").run();
  f.builds["1"] = [["y", "9", "VALID"], ["x", "8", "VALID"]];
  // 첫 빌드를 보낸 직후 다른 실행이 lease를 가져간 상황을 만든다.
  const stealing = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const response = await f.fetcher(input, init);
    if (new URL(String(input)).hostname === "discord.com") {
      f.db.prepare("UPDATE testflight_apps SET lease_token = 'other' WHERE app_id = '1'").run();
    }
    return response;
  }) as typeof fetch;
  const result = await pollTestFlightWorker(f.env, stealing);
  assert.equal(result.notifications, 1);
  assert.match(f.sent[0]!, /\(8\)/);
  // 뺏긴 lease는 지우지 않는다.
  assert.equal((f.db.prepare("SELECT lease_token t FROM testflight_apps WHERE app_id = '1'").get() as { t: string }).t, "other");
});

test("전송 후 기록 전에 실행이 끊겨도(SENDING이 남음) 다음 실행은 같은 빌드를 다시 보내지 않는다", async () => {
  const f = await fixture({ "1": [], "2": [] });
  await pollTestFlightWorker(f.env, f.fetcher);
  f.builds["1"] = [["c", "10", "VALID"]];
  const db = f.env.DB;
  // 전송 성공 뒤 최종 기록(state = VALID) 단계에서 실행이 끊긴 상황을 만든다.
  const cut = { ...f.env, DB: { ...db, prepare: (sql: string) => {
    if (sql.startsWith("INSERT OR REPLACE") && !sql.includes("'SENDING'")) throw new Error("worker cut");
    return db.prepare(sql);
  } } };
  await assert.rejects(pollTestFlightWorker(cut, f.fetcher));
  assert.equal(f.sent.length, 1);
  assert.equal((f.db.prepare("SELECT state FROM testflight_builds WHERE build_id = 'c'").get() as { state: string }).state, "SENDING");
  assert.equal((await pollTestFlightWorker(f.env, f.fetcher)).notifications, 0);
  assert.equal(f.sent.length, 1);
});

test("Discord 타임아웃·5xx는 게시됐을 수 있어 다시 보내지 않는다 (SENDING 유지)", async () => {
  for (const failure of ["timeout", "5xx"] as const) {
    const f = await fixture({ "1": [], "2": [] });
    await pollTestFlightWorker(f.env, f.fetcher);
    f.builds["1"] = [["t", "11", "VALID"]];
    const failing = (async (input: URL | RequestInfo, init?: RequestInit) => {
      if (new URL(String(input)).hostname !== "discord.com") return f.fetcher(input, init);
      if (failure === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return new Response("{}", { status: 502 });
    }) as typeof fetch;
    await assert.rejects(pollTestFlightWorker(f.env, failing), /TestFlight 조회 실패 1건/);
    assert.equal((f.db.prepare("SELECT state FROM testflight_builds WHERE build_id = 't'").get() as { state: string }).state, "SENDING");
    assert.equal((await pollTestFlightWorker(f.env, f.fetcher)).notifications, 0, failure);
    assert.equal(f.sent.length, 0);
  }
});

test("웹훅 실행은 전송 시간 예산이 지나면 새 전송을 시작하지 않고 다음 Cron에 넘긴다", async () => {
  const f = await fixture({ "1": [], "2": [] });
  await pollTestFlightWorker(f.env, f.fetcher);
  f.builds["1"] = [["late", "12", "VALID"]];
  assert.equal((await pollTestFlightWorker(f.env, f.fetcher, Date.now() - 1)).notifications, 0);
  assert.equal(f.db.prepare("SELECT 1 FROM testflight_builds WHERE build_id = 'late'").get(), undefined);
  assert.equal((await pollTestFlightWorker(f.env, f.fetcher)).notifications, 1);
});
