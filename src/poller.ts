import type { Config } from "./config.js";
import {
  observeLifecycle,
  type LifecycleState,
} from "./domain/lifecycle.js";
import type {
  GooglePlayClient,
  ReleaseNote,
  ReleaseObservation,
} from "./google-play.js";
import {
  notifyAll,
  type Notifier,
  type NotifierResolver,
} from "./notifier.js";
import { FileStateStore } from "./state-store.js";

export interface PollSummary {
  checked: number;
  notifications: number;
}

export async function pollOnce(
  config: Config,
  client: Pick<GooglePlayClient, "listReleases"> &
    Partial<Pick<GooglePlayClient, "getReleaseNotes">>,
  resolveNotifiers: NotifierResolver,
): Promise<PollSummary> {
  const store = new FileStateStore(config.stateFile);
  await store.load();

  const observations = (
    await Promise.all(
      config.apps.flatMap((app) =>
        app.tracks.map((track) => client.listReleases(app.packageName, track)),
      ),
    )
  ).flat();

  const trackBaselines = new Map<string, boolean>();
  for (const observation of observations) {
    const key = trackKey(observation);
    if (!trackBaselines.has(key)) {
      trackBaselines.set(key, store.hasTrack(observation));
    }
  }

  let notifications = 0;
  for (const observation of observations) {
    notifications += await processObservation(
      store,
      observation,
      resolveNotifiers(observation.packageName),
      trackBaselines.get(trackKey(observation)) ?? false,
      client,
    );
  }

  await store.save();
  return { checked: observations.length, notifications };
}

async function processObservation(
  store: FileStateStore,
  observation: ReleaseObservation,
  notifiers: Notifier[],
  trackHasBaseline: boolean,
  client: Partial<Pick<GooglePlayClient, "getReleaseNotes">>,
): Promise<number> {
  const previous = store.get(observation)?.state ?? null;
  const decision = observeLifecycle(previous, observation.state);
  const notification = isNewInternalDeployment(
    observation,
    previous,
    trackHasBaseline,
  )
    ? "internal-deployed"
    : decision.notification;

  if (notification) {
    await notifyAll(notifiers, {
      kind: notification,
      previous,
      release: observation,
      releaseNotes: notification === "internal-deployed"
        ? await fetchReleaseNotes(client, observation)
        : [],
    });
  }

  store.set(observation);
  return notification ? 1 : 0;
}

function isNewInternalDeployment(
  observation: ReleaseObservation,
  previous: LifecycleState | null,
  trackHasBaseline: boolean,
): boolean {
  return previous === null &&
    trackHasBaseline &&
    observation.track === "internal" &&
    observation.state === "RELEASE_LIFECYCLE_STATE_PUBLISHED";
}

// 출시노트는 edit을 열어야 읽힌다. 같은 서비스 계정으로 진행 중인 업로드의 edit을 무효화하지 않도록
// 업로드가 끝난 뒤에 나가는 internal 배포 알림에서만 읽는다. 조회가 실패해도 알림은 보낸다.
async function fetchReleaseNotes(
  client: Partial<Pick<GooglePlayClient, "getReleaseNotes">>,
  observation: ReleaseObservation,
): Promise<ReleaseNote[]> {
  if (!client.getReleaseNotes) return [];
  try {
    return await client.getReleaseNotes(
      observation.packageName,
      observation.track,
      observation.versionCode,
    );
  } catch (error) {
    console.warn(
      `${observation.packageName} ${observation.versionCode} 출시노트 조회 실패:`,
      error instanceof Error ? error.message : error,
    );
    return [];
  }
}

function trackKey(observation: ReleaseObservation): string {
  return `${observation.packageName}\0${observation.track}`;
}
