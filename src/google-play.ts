import { GoogleAuth } from "google-auth-library";
import {
  isLifecycleState,
  type LifecycleState,
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

const apiBase = "https://androidpublisher.googleapis.com/androidpublisher/v3";
// 요청이 멈추면 알림 전송과 다음 폴링까지 멈추므로 출시노트 조회에는 시간 제한을 둔다
const releaseNotesTimeoutMs = 15_000;

export class GooglePlayClient {
  private readonly auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });

  async listReleases(
    packageName: string,
    track: string,
  ): Promise<ReleaseObservation[]> {
    const client = await this.auth.getClient();
    const url =
      "https://androidpublisher.googleapis.com/androidpublisher/v3/" +
      `applications/${encodeURIComponent(packageName)}/` +
      `tracks/${encodeURIComponent(track)}/releases`;
    const response = await client.request<ReleaseListResponse>({ url });

    return (response.data.releases ?? []).flatMap((release) => {
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

  // 출시노트는 releases 조회에 없고 edits API에서만 읽힌다. edit은 커밋하지 않고 바로 지운다.
  async getReleaseNotes(
    packageName: string,
    track: string,
    versionCode: number,
  ): Promise<ReleaseNote[]> {
    const client = await this.auth.getClient();
    const editsUrl = `${apiBase}/applications/${encodeURIComponent(packageName)}/edits`;
    const edit = await client.request<{ id: string }>({
      url: editsUrl,
      method: "POST",
      data: {},
      timeout: releaseNotesTimeoutMs,
    });
    const editUrl = `${editsUrl}/${encodeURIComponent(edit.data.id)}`;

    try {
      const response = await client.request<EditTrackResponse>({
        url: `${editUrl}/tracks/${encodeURIComponent(track)}`,
        timeout: releaseNotesTimeoutMs,
      });
      const release = (response.data.releases ?? []).find((candidate) =>
        (candidate.versionCodes ?? []).includes(String(versionCode))
      );
      return (release?.releaseNotes ?? []).flatMap((note) =>
        note.language && note.text
          ? [{ language: note.language, text: note.text }]
          : []
      );
    } finally {
      // 지우기 실패가 읽은 출시노트나 원래 오류를 덮어쓰지 않게 한다. 남은 edit은 Play가 만료시킨다.
      await client
        .request({ url: editUrl, method: "DELETE", timeout: releaseNotesTimeoutMs })
        .catch((error: unknown) => {
          console.warn(
            `${packageName} edit 삭제 실패:`,
            error instanceof Error ? error.message : error,
          );
        });
    }
  }
}
