-- yeobee-testflight-ping Worker(src/testflight-worker.ts)가 쓰는 TestFlight 알림 상태.
-- 행이 있으면 기준점을 저장한 앱이다. lease는 Cron과 웹훅이 같은 앱을 동시에 처리하지 않게 막는다.
CREATE TABLE testflight_apps (
  app_id TEXT PRIMARY KEY,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT NOT NULL DEFAULT ''
);

CREATE TABLE testflight_builds (
  app_id TEXT NOT NULL,
  build_id TEXT NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY (app_id, build_id)
);
