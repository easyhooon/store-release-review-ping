// Node 전용 API(fs, crypto)를 쓰지 않는 순수 함수만 둔다. 로컬 CLI와 Cloudflare Worker가 함께 쓴다.

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
  app: { appName: string; label: string },
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
