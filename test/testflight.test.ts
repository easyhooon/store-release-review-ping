import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appleCredentialsFromEnv, appleToken, createTestFlightClient, formatTestFlightMessage,
  loadTestFlightConfig, parseBuilds, pollTestFlightOnce,
  type BetaBuildNote, type TestFlightBuild, type TestFlightClient, type TestFlightConfig,
} from "../src/testflight.js";

const prd = { appStoreId: "6475346701", appName: "여비", label: "PRD", discordWebhookEnv: "HOOK" };
const dev = { appStoreId: "6759133612", appName: "여비", label: "DEV", discordWebhookEnv: "HOOK" };

function build(id: string, number: string, processingState = "VALID"): TestFlightBuild {
  return { id, buildNumber: number, version: "1.8.11", processingState, uploadedDate: "2026-11-10T08:21:22-08:00" };
}

async function withConfig(run: (config: TestFlightConfig) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "testflight-ping-"));
  try {
    await run({ pollIntervalSeconds: 300, stateFile: join(dir, "state.json"), apps: [prd, dev] });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function fakeClient(builds: Record<string, TestFlightBuild[]>, notes: (id: string) => Promise<BetaBuildNote[]> =
  async () => [{ locale: "ko", whatsNew: "정산 누락 수정\n" }]): TestFlightClient {
  return { listBuilds: async (appId) => builds[appId] ?? [], getNotes: notes };
}

test("Android Internal Testing 알림 형식으로 버전·빌드 번호·ko 업데이트노트를 표시한다", () => {
  assert.equal(formatTestFlightMessage(prd, build("b", "1"), [
    { locale: "en-US", whatsNew: "Fix" },
    { locale: "ko", whatsNew: "결제한 사람 이름 표시 수정\n" },
  ]), [
    "[App Store Release Review Ping] 🧪 TestFlight 새 빌드 배포",
    "여비 PRD · TestFlight",
    "버전 1.8.11 (1)",
    "",
    "업데이트노트",
    "결제한 사람 이름 표시 수정",
  ].join("\n"));
  assert.match(formatTestFlightMessage(prd, build("b", "1"), [{ locale: "en-US", whatsNew: "Fix" }]), /업데이트노트\nFix$/);
  assert.doesNotMatch(formatTestFlightMessage(prd, build("b", "1"), [{ locale: "ko", whatsNew: "  \n" }]), /업데이트노트/);
});

test("첫 조회는 앱별 기준점만 저장하고 이후 새 VALID 빌드를 오래된 순서로 한 번씩 알린다", async () => {
  await withConfig(async (config) => {
    const builds: Record<string, TestFlightBuild[]> = { [prd.appStoreId]: [build("p1", "1")], [dev.appStoreId]: [] };
    const sent: string[] = [];
    const send = async (app: typeof prd, message: string) => { sent.push(`${app.label}:${message}`); };
    assert.deepEqual(await pollTestFlightOnce(config, fakeClient(builds), send),
      { checked: 1, notifications: 0, baselines: 2 });
    builds[prd.appStoreId] = [build("p3", "3"), build("p2", "2"), build("p1", "1")];
    builds[dev.appStoreId] = [build("d1", "7")];
    assert.equal((await pollTestFlightOnce(config, fakeClient(builds), send)).notifications, 3);
    assert.deepEqual(sent.map((m) => m.split("\n")[2]), ["버전 1.8.11 (2)", "버전 1.8.11 (3)", "버전 1.8.11 (7)"]);
    assert.match(sent[2]!, /^DEV:.*\n여비 DEV · TestFlight/);
    assert.equal((await pollTestFlightOnce(config, fakeClient(builds), send)).notifications, 0);
  });
});

test("처리 중 빌드는 기준점에 넣지 않고 VALID가 되면 알리며 실패 빌드는 알리지 않는다", async () => {
  await withConfig(async (config) => {
    const builds: Record<string, TestFlightBuild[]> = { [prd.appStoreId]: [build("p1", "1", "PROCESSING")] };
    let count = 0;
    const send = async () => { count++; };
    await pollTestFlightOnce(config, fakeClient(builds), send);
    await pollTestFlightOnce(config, fakeClient(builds), send);
    assert.equal(count, 0);
    builds[prd.appStoreId] = [build("p2", "2", "FAILED"), build("p1", "1")];
    assert.equal((await pollTestFlightOnce(config, fakeClient(builds), send)).notifications, 1);
    assert.equal(JSON.parse(await readFile(config.stateFile, "utf8")).apps[prd.appStoreId].seen.p2, "FAILED");
  });
});

test("업데이트노트 조회가 실패해도 알리고, 전송이 실패하면 다음 조회에서 재시도한다", async () => {
  await withConfig(async (config) => {
    const builds: Record<string, TestFlightBuild[]> = { [prd.appStoreId]: [] };
    await pollTestFlightOnce(config, fakeClient(builds), async () => {});
    builds[prd.appStoreId] = [build("p1", "1")];
    const failingNotes = fakeClient(builds, async () => { throw new Error("timeout"); });
    await assert.rejects(pollTestFlightOnce(config, failingNotes, async () => { throw new Error("HTTP 500"); }), AggregateError);
    const sent: string[] = [];
    await pollTestFlightOnce(config, failingNotes, async (_app, message) => { sent.push(message); });
    assert.equal(sent.length, 1);
    assert.doesNotMatch(sent[0]!, /업데이트노트/);
  });
});

test("builds 응답에서 preReleaseVersion의 마케팅 버전을 연결한다", () => {
  assert.deepEqual(parseBuilds({
    data: [{
      id: "b1",
      attributes: { version: "1", uploadedDate: "2026-11-10T08:21:22-08:00", processingState: "VALID" },
      relationships: { preReleaseVersion: { data: { type: "preReleaseVersions", id: "v1" } } },
    }],
    included: [{ type: "preReleaseVersions", id: "v1", attributes: { version: "1.8.11" } }],
  }), [{ id: "b1", buildNumber: "1", version: "1.8.11", processingState: "VALID", uploadedDate: "2026-11-10T08:21:22-08:00" }]);
  assert.throws(() => parseBuilds({ data: [{ id: "b1", attributes: {} }] }), /필수 필드/);
  assert.throws(() => parseBuilds({}), /data 배열/);
});

test("개인 키는 sub, 팀 키는 iss로 서명하고 요청에 타임아웃을 건다", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const payload = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
  const individual = appleToken({ type: "individual", keyId: "KEY1", keyPath: "" }, pem, 1_000_000);
  assert.deepEqual(payload(individual), { sub: "user", iat: 1000, exp: 2200, aud: "appstoreconnect-v1" });
  const [h, p, s] = individual.split(".");
  assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(s!, "base64url")));
  const issuer = "00000000-0000-0000-0000-000000000000";
  assert.equal(payload(appleToken({ type: "team", keyId: "KEY1", issuerId: issuer, keyPath: "" }, pem)).iss, issuer);

  assert.deepEqual(appleCredentialsFromEnv({ APP_STORE_CONNECT_KEY_TYPE: "individual",
    APP_STORE_CONNECT_KEY_ID: "K", APP_STORE_CONNECT_KEY_PATH: "/k.p8" }), { type: "individual", keyId: "K", keyPath: "/k.p8" });
  assert.throws(() => appleCredentialsFromEnv({ APP_STORE_CONNECT_KEY_ID: "K", APP_STORE_CONNECT_KEY_PATH: "/k.p8" }), /ISSUER_ID/);

  const dir = await mkdtemp(join(tmpdir(), "testflight-key-"));
  try {
    await writeFile(join(dir, "key.p8"), pem);
    const requests: Array<{ url: string; signal: unknown }> = [];
    const client = await createTestFlightClient({ type: "individual", keyId: "KEY1", keyPath: join(dir, "key.p8") },
      (async (url: URL, init: RequestInit) => {
        requests.push({ url: url.toString(), signal: init.signal });
        return new Response(JSON.stringify({ data: [{ attributes: { locale: "ko", whatsNew: "수정" } }] }));
      }) as typeof fetch);
    assert.deepEqual(await client.getNotes("b1"), [{ locale: "ko", whatsNew: "수정" }]);
    assert.match(requests[0]!.url, /\/v1\/builds\/b1\/betaBuildLocalizations/);
    assert.ok(requests[0]!.signal instanceof AbortSignal);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("설정은 앱 ID 중복과 잘못된 웹훅 변수 이름을 거부한다", async () => {
  const dir = await mkdtemp(join(tmpdir(), "testflight-config-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ stateFile: "s.json", apps: [prd, prd] }));
    await assert.rejects(loadTestFlightConfig(path), /중복/);
    await writeFile(path, JSON.stringify({ stateFile: "s.json", apps: [{ ...prd, discordWebhookEnv: "bad-name" }] }));
    await assert.rejects(loadTestFlightConfig(path), /환경 변수/);
    await writeFile(path, JSON.stringify({ stateFile: "s.json", apps: [prd, dev] }));
    assert.equal((await loadTestFlightConfig(path)).pollIntervalSeconds, 300);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("긴 업데이트노트는 Discord 2000자 제한 안으로 자른다", () => {
  const message = formatTestFlightMessage(prd, build("b", "1"), [{ locale: "ko", whatsNew: "가".repeat(4000) }]);
  assert.equal(message.length, 2000);
  assert.ok(message.endsWith("…"));
});

test("앱 하나의 조회·전송 실패가 다른 앱 알림을 막지 않고, 실패는 모아서 던진다", async () => {
  await withConfig(async (config) => {
    const builds: Record<string, TestFlightBuild[]> = {};
    await pollTestFlightOnce(config, fakeClient(builds), async () => {});
    builds[prd.appStoreId] = [build("p1", "1")];
    builds[dev.appStoreId] = [build("d1", "7")];
    const sent: string[] = [];
    await assert.rejects(pollTestFlightOnce(config, fakeClient(builds), async (app) => {
      if (app.label === "PRD") throw new Error("HTTP 400");
      sent.push(app.label);
    }), (error: unknown) => error instanceof AggregateError && /1건/.test(error.message));
    assert.deepEqual(sent, ["DEV"]);
    const failingList: TestFlightClient = { ...fakeClient(builds), listBuilds: async (id) => {
      if (id === prd.appStoreId) throw new Error("HTTP 503");
      return builds[id] ?? [];
    } };
    await assert.rejects(pollTestFlightOnce(config, failingList, async () => {}), AggregateError);
    assert.equal((await pollTestFlightOnce(config, fakeClient(builds), async (app) => { sent.push(app.label); })).notifications, 1);
    assert.deepEqual(sent, ["DEV", "PRD"]);
  });
});
