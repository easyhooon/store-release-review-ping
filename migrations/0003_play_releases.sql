-- yeobee-play-release-ping·bandalart-play-release-ping Worker(src/play-release-worker.ts)가 쓰는 Google Play 심사 상태.
-- 로컬 `.data/state.json`의 `packageName|track|versionCode`별 상태를 행으로 옮긴 것이다.
-- 같은 (package_name, track)에 행이 하나라도 있으면 그 트랙은 기준점을 저장한 것으로 본다(로컬 hasTrack과 같다).
CREATE TABLE play_apps (
  package_name TEXT PRIMARY KEY,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT NOT NULL DEFAULT ''
);

-- sending = 1: 알림을 보내기 직전에 새 상태로 기록했고 전송 성공을 확인하지 못했다.
-- previous_state: Discord가 4xx로 거절했을 때 되돌릴 이전 상태. NULL이면 처음 본 versionCode라 행을 지운다.
CREATE TABLE play_releases (
  package_name TEXT NOT NULL,
  track TEXT NOT NULL,
  version_code INTEGER NOT NULL,
  state TEXT NOT NULL,
  release_name TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  sending INTEGER NOT NULL DEFAULT 0 CHECK (sending IN (0, 1)),
  previous_state TEXT,
  PRIMARY KEY (package_name, track, version_code)
);
