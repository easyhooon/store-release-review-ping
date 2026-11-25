// Node 전용 API와 google-auth-library를 쓰지 않는 순수 함수만 둔다. 로컬 CLI와 Cloudflare Worker가 함께 쓴다.
import {
  isLifecycleState,
  type LifecycleState,
  type NotificationKind,
} from "./domain/lifecycle.js";

export interface ReleaseObservation {
  packageName: string;
  track: string;
  releaseName: string;
  versionCode: number;
  state: LifecycleState;
}

export interface ReleaseNote {
  language: string;
  text: string;
}

export interface NotificationEvent {
  kind: NotificationKind;
  previous: LifecycleState | null;
  release: ReleaseObservation;
  releaseNotes?: ReleaseNote[];
}

interface ReleaseListResponse {
  releases?: Array<{
    releaseName?: string;
    track?: string;
    activeArtifacts?: Array<{ versionCode?: number }>;
    releaseLifecycleState?: unknown;
  }>;
}

interface EditTrackResponse {
  releases?: Array<{
    versionCodes?: string[];
    releaseNotes?: Array<{ language?: string; text?: string }>;
  }>;
}

const titles: Record<NotificationKind, string> = {
  "internal-deployed": "🧪 Internal Testing 새 버전 배포",
  "action-required": "⚠️ 심사 전송 필요",
  approved: "✅ 심사 승인 완료 — 게시 대기",
  rejected: "🚨 심사 거절",
  published: "🚀 Google Play 게시 완료",
};

/** `applications.tracks.releases.list` 응답을 versionCode별 관측으로 편다. */
export function parseReleaseList(
  body: unknown,
  packageName: string,
  track: string,
): ReleaseObservation[] {
  return ((body as ReleaseListResponse).releases ?? []).flatMap((release) => {
    if (!isLifecycleState(release.releaseLifecycleState)) return [];
    const state = release.releaseLifecycleState;

    return (release.activeArtifacts ?? []).flatMap((artifact) => {
      if (!Number.isInteger(artifact.versionCode)) return [];

      return [
        {
          packageName,
          track: release.track ?? track,
          releaseName: release.releaseName ?? "이름 없음",
          versionCode: artifact.versionCode as number,
          state,
        },
      ];
    });
  });
}

/** edits.tracks.get 응답에서 versionCode가 든 릴리스의 출시노트를 꺼낸다. */
export function parseEditTrackReleaseNotes(body: unknown, versionCode: number): ReleaseNote[] {
  const release = ((body as EditTrackResponse).releases ?? []).find((candidate) =>
    (candidate.versionCodes ?? []).includes(String(versionCode))
  );
  return (release?.releaseNotes ?? []).flatMap((note) =>
    note.language && note.text
      ? [{ language: note.language, text: note.text }]
      : []
  );
}

export function formatMessage(event: NotificationEvent): string {
  const release = event.release;
  const lines = [
    `[Google Play Release Review Ping] ${titles[event.kind]}`,
    `${release.packageName} · ${release.track}`,
    `버전 ${release.releaseName} (${release.versionCode})`,
  ];
  if (event.previous) {
    lines.push(`${shortState(event.previous)} → ${shortState(release.state)}`);
  }
  const note = pickReleaseNote(event.releaseNotes ?? []);
  if (note) {
    lines.push("", "출시노트", note.text);
  }
  return lines.join("\n");
}

function pickReleaseNote(notes: ReleaseNote[]): ReleaseNote | undefined {
  return notes.find((note) => note.language === "ko-KR") ?? notes[0];
}

function shortState(state: LifecycleState): string {
  return state.replace("RELEASE_LIFECYCLE_STATE_", "");
}
