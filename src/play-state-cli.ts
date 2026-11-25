// 로컬 상태 파일(.data/state.json)과 Worker D1(play_releases)을 서로 옮긴다.
//   seed <state.json> <packageName>     → D1에 넣을 INSERT SQL을 stdout으로 출력한다 (Worker 전환 때)
//   export <d1-result.json> <packageName> → `wrangler d1 execute --json` 결과를 로컬 상태 파일 형식으로 출력한다 (로컬로 되돌릴 때)
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isLifecycleState } from "./domain/lifecycle.js";

interface StateDocument {
  version: 1;
  observations: Record<string, { state: string; releaseName: string; observedAt: string }>;
}

export function seedSql(document: unknown, packageName: string): string {
  const state = document as Partial<StateDocument>;
  if (state.version !== 1 || !state.observations || typeof state.observations !== "object") {
    throw new Error("상태 파일 형식(version 1)이 아닙니다.");
  }
  const values = Object.entries(state.observations).flatMap(([key, value]) => {
    const [rawPackage, rawTrack, rawVersionCode, ...rest] = key.split("|");
    if (rest.length > 0 || rawVersionCode === undefined) throw new Error(`상태 키 형식이 아닙니다: ${key}`);
    const keyPackage = decodeURIComponent(rawPackage);
    if (keyPackage !== packageName) return [];
    const track = decodeURIComponent(rawTrack);
    const versionCode = Number(decodeURIComponent(rawVersionCode));
    if (!Number.isInteger(versionCode) || !isLifecycleState(value.state) ||
        typeof value.releaseName !== "string" || typeof value.observedAt !== "string") {
      throw new Error(`상태 값이 올바르지 않습니다: ${key}`);
    }
    return [`(${[packageName, track].map(literal).join(", ")}, ${versionCode}, ${
      [value.state, value.releaseName, value.observedAt].map(literal).join(", ")})`];
  });
  if (values.length === 0) throw new Error(`${packageName} 관측이 상태 파일에 없습니다.`);
  // 빈 테이블에만 넣는다. 이미 행이 있으면 INSERT가 실패해 이중 seed를 막는다.
  return `INSERT INTO play_releases (package_name, track, version_code, state, release_name, observed_at) VALUES\n${
    values.join(",\n")};\n`;
}

export function exportState(d1Result: unknown, packageName: string): StateDocument {
  // `wrangler d1 execute --json`은 [{ results: [...] }] 모양으로 출력한다.
  const rows = (Array.isArray(d1Result) ? d1Result[0]?.results : undefined) as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(rows)) throw new Error("wrangler d1 execute --json 결과 형식이 아닙니다.");
  const observations: StateDocument["observations"] = {};
  for (const row of rows) {
    if (row.package_name !== packageName) continue;
    const key = [packageName, String(row.track), String(row.version_code)].map(encodeURIComponent).join("|");
    observations[key] = {
      state: String(row.state),
      releaseName: String(row.release_name),
      observedAt: String(row.observed_at),
    };
  }
  return { version: 1, observations };
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, path, packageName] = process.argv.slice(2);
  if (!path || !packageName || (command !== "seed" && command !== "export")) {
    console.error("사용법: play-state-cli.ts seed <state.json> <packageName> | export <d1-result.json> <packageName>");
    process.exit(2);
  }
  const input = JSON.parse(await readFile(path, "utf8")) as unknown;
  process.stdout.write(command === "seed"
    ? seedSql(input, packageName)
    : `${JSON.stringify(exportState(input, packageName), null, 2)}\n`);
}
