# Google Play 심사 알림 Cloudflare Worker 운영

Google Play 릴리스 심사 상태 알림(`releaseLifecycleState` 전환, Internal Testing 새 버전과 출시노트)은 Mac의 launchd `pnpm watch` 대신 Cloudflare Worker가 보냅니다. Mac을 꺼도 알림이 옵니다. 로컬 `src/cli.ts`는 Worker 장애 때 되살릴 대체 경로로 남겨 둡니다.

## 구성

앱마다 Worker를 하나씩 둡니다. 코드는 `src/play-release-worker.ts` 하나이고 wrangler 설정만 다릅니다.

| Worker | 설정 | 패키지 | D1 |
| --- | --- | --- | --- |
| `yeobee-play-release-ping` | `wrangler.yeobee-play.jsonc` | `com.yeobee` | `yeobee-ios-webhook-events` |
| `bandalart-play-release-ping` | `wrangler.bandalart-play.jsonc` | `com.nexters.bandalart` | `bandalart-ios-webhook-events` |

앱별로 나눈 이유:

- 서비스 계정이 다릅니다(여비 `yeobeeios`, 반다라트 `bandalart-396909` 프로젝트). Google 할당량도 프로젝트별입니다.
- Discord 채널이 다릅니다.
- 한 앱의 키 만료·권한 오류가 다른 앱 알림을 막지 않습니다.
- iOS 웹훅 Worker도 앱별(`yeobee-ios-store-webhook`, `bandalart-ios-store-webhook`)입니다.

D1은 새로 만들지 않고 앱별 기존 D1에 테이블을 추가했습니다(`migrations/0003_play_releases.sql`). 무료 플랜의 D1 개수를 아끼고, 앱별로 한 D1에 상태가 모입니다.

| 구성 | 내용 |
| --- | --- |
| Cron Trigger | 15분마다(`*/15 * * * *`). 로컬과 같은 주기입니다. 할당량은 [QUOTAS.md](QUOTAS.md) |
| HTTP | 없음(`workers_dev: false`). Google Play에는 심사 상태 웹훅이 없습니다(RTDN은 결제 전용) |
| D1 | `play_releases`(패키지·트랙·versionCode별 마지막 상태), `play_apps`(lease) |
| 비밀값 | `GOOGLE_SERVICE_ACCOUNT_JSON`(서비스 계정 JSON 키 파일 내용 전체), `DISCORD_WEBHOOK_URL` |
| vars | `PACKAGE_NAME`, `TRACKS`(JSON 배열, `["internal","production"]`) |

인증은 `google-auth-library` 대신 `src/google-jwt.ts`가 WebCrypto RS256으로 JWT를 서명해 `https://oauth2.googleapis.com/token`에서 access token을 받습니다. 실행마다 새로 받습니다.

## 동작

알림 규칙은 로컬 `src/poller.ts`와 같습니다.

- 트랙에 저장된 행이 하나도 없으면 그 트랙의 첫 조회는 기준점만 저장하고 보내지 않습니다.
- 저장된 상태에서 `NOT_SENT_FOR_REVIEW`, `APPROVED_NOT_PUBLISHED`, `NOT_APPROVED`, `PUBLISHED`로 바뀌면 알립니다.
- 기준점이 있는 `internal` 트랙에 처음 보는 versionCode가 `PUBLISHED`로 나타나면 Internal Testing 배포 알림을 보냅니다. 이때만 edits API로 edit을 만들어 출시노트(`ko-KR` 우선)를 읽고, 커밋하지 않고 지웁니다. 출시노트 조회가 실패해도 알림은 보냅니다.

같은 알림을 두 번 보내지 않도록 다음 규칙을 둡니다:

- 앱별 lease(300초)를 잡은 실행만 조회합니다. 알림을 보낼 때마다 lease를 연장하고, 뺏겼으면 멈춥니다.
- 보내기 전에 새 상태와 `sending = 1`을 기록하고, 성공하면 `sending = 0`으로 바꿉니다.
- Discord가 4xx(429 포함)로 거절했을 때만 이전 상태로 되돌려(처음 본 versionCode는 행 삭제) 다음 Cron에서 다시 보냅니다.
- 타임아웃·네트워크 오류·5xx는 실제로 게시됐을 수 있어 `sending = 1`을 남기고 다시 보내지 않습니다.

그 대가로 전송 도중 실행이 끊기고 Discord도 받지 못한 알림은 빠집니다. 다음 실행부터 로그에 `전송 확인 안 된 알림(sending=1)` 경고가 찍힙니다. 확인하고 정리하는 쿼리:

```bash
npx wrangler d1 execute yeobee-ios-webhook-events --remote -c wrangler.yeobee-play.jsonc --command "SELECT * FROM play_releases WHERE sending = 1"
```

```bash
npx wrangler d1 execute yeobee-ios-webhook-events --remote -c wrangler.yeobee-play.jsonc --command "UPDATE play_releases SET sending = 0, previous_state = NULL WHERE sending = 1"
```

반다라트는 D1 이름을 `bandalart-ios-webhook-events`, 설정을 `wrangler.bandalart-play.jsonc`로 바꿉니다.

로그는 `npx wrangler tail yeobee-play-release-ping`(반다라트 `bandalart-play-release-ping`)으로 봅니다. 정상 실행은 `Play com.yeobee checked=2 notifications=0 skipped=false`처럼 찍힙니다.

## 처음 배포하기

로컬 launchd와 Worker를 동시에 켜면 같은 전환이 두 번 알려집니다. 로컬을 먼저 끄고, 그 시점의 상태 파일로 D1을 채운 뒤 Worker를 켭니다. 여비 기준이며, 반다라트는 괄호 안 값으로 바꿉니다.

1. 로컬 감시 중지와 plist 보관:

   ```bash
   launchctl bootout gui/$(id -u)/com.mps-jihun-lee.play-review-ping
   ```

   ```bash
   mkdir -p ~/Library/LaunchAgents/disabled && mv ~/Library/LaunchAgents/com.mps-jihun-lee.play-review-ping.plist ~/Library/LaunchAgents/disabled/
   ```

   반다라트: `com.easyhooon.bandalart.play-review-ping`.

2. 상태 파일 스냅샷으로 seed SQL 만들기(여비 `.data/state.json`, 반다라트 `/Users/medi/Documents/Codex/BandalartAlerts/state/play.json`):

   ```bash
   node --import tsx src/play-state-cli.ts seed .data/state.json com.yeobee > /tmp/yeobee-play-seed.sql
   ```

3. 테이블 만들기:

   ```bash
   npx wrangler d1 migrations apply yeobee-ios-webhook-events --remote -c wrangler.yeobee-play.jsonc
   ```

   반다라트 D1은 `0001`을 마이그레이션 기록 없이 만들어서 `migrations apply`가 `0001`부터 다시 실행하다 실패합니다. `0003`만 직접 적용합니다:

   ```bash
   npx wrangler d1 execute bandalart-ios-webhook-events --remote -c wrangler.bandalart-play.jsonc --file migrations/0003_play_releases.sql
   ```

4. seed 넣기(테이블이 비어 있을 때만 성공합니다):

   ```bash
   npx wrangler d1 execute yeobee-ios-webhook-events --remote -c wrangler.yeobee-play.jsonc --file /tmp/yeobee-play-seed.sql
   ```

5. 배포:

   ```bash
   npx wrangler deploy -c wrangler.yeobee-play.jsonc
   ```

6. 비밀값 등록. 값을 화면이나 명령줄 인수에 남기지 않고 stdin으로 넣습니다:

   ```bash
   npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON -c wrangler.yeobee-play.jsonc < /Users/medi/AndroidStudioProjects/YeoBee-Android/playstore/service-account-key.json
   ```

   ```bash
   grep '^DISCORD_WEBHOOK_URL=' .env | cut -d= -f2- | tr -d '\n' | npx wrangler secret put DISCORD_WEBHOOK_URL -c wrangler.yeobee-play.jsonc
   ```

   반다라트: 키 `/Users/medi/StudioProjects/Bandalart/playstore/service-account-key.json`, 웹훅은 `/Users/medi/Documents/Codex/BandalartAlerts/play.env`의 `BANDALART_PLAY_WEBHOOK_URL`.

   배포와 비밀값 등록 사이에 Cron이 돌면 `설정이 빠졌습니다` 오류로 끝납니다. D1과 Discord는 건드리지 않습니다.

7. `npx wrangler tail yeobee-play-release-ping`으로 첫 Cron이 `notifications=0`인지 확인합니다.

## 로컬로 되돌리기

Worker 장애가 길어질 때만 씁니다. 두 경로를 동시에 켜지 않습니다.

1. Worker의 Cron을 끕니다. 설정의 `"crons"`를 `[]`로 바꿔 `npx wrangler deploy -c wrangler.yeobee-play.jsonc`로 배포하거나, `npx wrangler delete yeobee-play-release-ping`으로 Worker를 지웁니다(D1은 남습니다).
2. D1 상태를 로컬 상태 파일로 내보냅니다. Worker가 전환 후 본 상태를 로컬이 이어받아 같은 알림이 다시 나가지 않습니다:

   ```bash
   npx wrangler d1 execute yeobee-ios-webhook-events --remote -c wrangler.yeobee-play.jsonc --json --command "SELECT * FROM play_releases" > /tmp/yeobee-play-d1.json
   ```

   ```bash
   node --import tsx src/play-state-cli.ts export /tmp/yeobee-play-d1.json com.yeobee > .data/state.json
   ```

   내보내기를 건너뛰면 로컬 상태 파일이 Worker 전환 뒤의 상태를 몰라, 그 사이 바뀐 상태가 한 번씩 다시 알려질 수 있습니다.
3. plist를 되돌리고 켭니다:

   ```bash
   mv ~/Library/LaunchAgents/disabled/com.mps-jihun-lee.play-review-ping.plist ~/Library/LaunchAgents/
   ```

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mps-jihun-lee.play-review-ping.plist
   ```

반다라트는 상태 파일 `/Users/medi/Documents/Codex/BandalartAlerts/state/play.json`, plist `com.easyhooon.bandalart.play-review-ping`으로 바꿉니다.

## 비밀값 교체

서비스 계정 키를 새로 발급했으면 6단계의 `secret put` 명령을 다시 실행합니다. 재배포는 필요 없습니다. 이전 키는 Google Cloud 콘솔에서 지웁니다.
