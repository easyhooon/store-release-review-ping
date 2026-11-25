import { nextPollDelaySeconds } from "./polling-delay.js";
import {
  appleCredentialsFromEnv, createTestFlightClient, fetchNotes, formatTestFlightMessage,
  loadTestFlightConfig, pollTestFlightOnce, type TestFlightAppConfig,
} from "./testflight.js";

const mode = process.argv[2];
if (mode !== "once" && mode !== "watch" && mode !== "preview") {
  throw new Error("사용법: testflight-cli.ts once|watch|preview");
}
const config = await loadTestFlightConfig(process.env.TESTFLIGHT_PING_CONFIG ?? "testflight.config.json");
const client = await createTestFlightClient(appleCredentialsFromEnv());

// preview: 앱별 최신 VALID 빌드의 메시지를 콘솔에만 출력한다. 상태 파일과 Discord는 건드리지 않는다.
if (mode === "preview") {
  for (const app of config.apps) {
    const build = (await client.listBuilds(app.appStoreId)).find((item) => item.processingState === "VALID");
    if (!build) {
      console.log(`${app.appName} ${app.label}: VALID 빌드 없음\n`);
      continue;
    }
    console.log(`${formatTestFlightMessage(app, build, await fetchNotes(client, build))}\n`);
  }
  process.exit(0);
}

const webhooks = new Map(config.apps.map((app) => {
  const url = process.env[app.discordWebhookEnv];
  if (!url) throw new Error(`${app.appName} ${app.label} Discord 웹훅 환경 변수 ${app.discordWebhookEnv}가 필요합니다.`);
  return [app.appStoreId, url];
}));
const send = async (app: TestFlightAppConfig, message: string) => {
  const response = await fetch(webhooks.get(app.appStoreId)!, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // 노트에 @everyone 등이 있어도 멘션되지 않게 한다.
    body: JSON.stringify({ content: message, allowed_mentions: { parse: [] } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Discord 웹훅 전송 실패: HTTP ${response.status}`);
};

let failures = 0;
async function tick(): Promise<void> {
  const started = new Date().toISOString();
  try {
    const result = await pollTestFlightOnce(config, client, send);
    failures = 0;
    console.log(`${started} checked=${result.checked} notifications=${result.notifications} baselines=${result.baselines}`);
  } catch (error) {
    failures++;
    console.error(`${started} TestFlight poll failed`, error);
    if (mode === "once") process.exitCode = 1;
  }
}

if (mode === "once") {
  await tick();
} else {
  for (;;) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve,
      nextPollDelaySeconds(config.pollIntervalSeconds, failures) * 1000));
  }
}
