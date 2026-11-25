# Google Play 심사 알림 Cloudflare Worker 운영

Google Play 릴리스 심사 상태 알림(`releaseLifecycleState` 전환, Internal Testing 새 버전과 출시노트)은 Mac의 launchd `pnpm watch` 대신 Cloudflare Worker가 보냅니다. Mac을 꺼도 알림이 옵니다. 로컬 `src/cli.ts`는 Worker 장애 때 되살릴 대체 경로로 남겨 둡니다.

## 구성

Worker `play-release-ping` 하나와 Cron 하나(`*/15 * * * *`)로 여비와 반다라트를 함께 조회합니다. 설정은 `wrangler.play.jsonc`, 코드는 `src/play-release-worker.ts`입니다.

Cloudflare 무료 플랜은 계정당 Cron Trigger가 5개입니다. TestFlight, 리뷰, AdMob 알림과 함께 쓰려고 앱마다 Worker를 두지 않았습니다. 대신 앱별로 다음을 나눕니다:

| 앱 | `PLAY_APPS` key | 패키지 | D1 바인딩(데이터베이스) | 비밀값 |
| --- | --- | --- | --- | --- |
| 여비 | `YEOBEE` | `com.yeobee` | `YEOBEE_DB`(`yeobee-ios-webhook-events`) | `YEOBEE_GOOGLE_SERVICE_ACCOUNT_JSON`, `YEOBEE_DISCORD_WEBHOOK_URL` |
| 반다라트 | `BANDALART` | `com.nexters.bandalart` | `BANDALART_DB`(`bandalart-ios-webhook-events`) | `BANDALART_GOOGLE_SERVICE_ACCOUNT_JSON`, `BANDALART_DISCORD_WEBHOOK_URL` |

- 서비스 계정이 다릅니다(여비 `yeobeeios`, 반다라트 `bandalart-396909` 프로젝트). Google 할당량도 프로젝트별입니다.
- 앱마다 lease와 오류를 따로 처리합니다. 한 앱의 키 만료·할당량·Discord 오류·비밀값 누락이 다른 앱 알림을 막지 않습니다. 실패는 실행 끝에 `Play poll failed` 로그로 모아 남깁니다.
- D1은 새로 만들지 않고 앱별 기존 D1에 테이블을 추가했습니다(`migrations/0003_play_releases.sql`). 무료 플랜의 D1 개수를 아끼고, 앱 상태가 앱별 D1에 모입니다.

앱을 더하려면 `PLAY_APPS`에 `{"key":"NEW","packageName":"…","tracks":[…]}`를 넣고 `NEW_DB` 바인딩과 `NEW_GOOGLE_SERVICE_ACCOUNT_JSON`, `NEW_DISCORD_WEBHOOK_URL` 비밀값을 추가합니다.

| 구성 | 내용 |
| --- | --- |
| Cron Trigger | 15분마다. 로컬과 같은 주기입니다. 할당량은 [QUOTAS.md](QUOTAS.md) |
| HTTP | 없음(`workers_dev: false`). Google Play에는 심사 상태 웹훅이 없습니다(RTDN은 결제 전용) |
| D1 | 앱별 D1의 `play_releases`(패키지·트랙·versionCode별 마지막 상태), `play_apps`(lease) |

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
- 알림 없는 관측(처음 본 versionCode, `IN_REVIEW` 등)은 전송보다 먼저 저장합니다. 전송이 실패해도 다음 전환을 놓치지 않습니다.
- 한 알림이 실패해도 같은 앱의 다음 알림은 계속 보내고, 실패는 실행 끝에 오류로 남깁니다.
- Discord 웹훅 주소가 `https://discord.com/api/webhooks/` 형식이 아니면 lease와 D1을 건드리기 전에 그 앱만 실패합니다.

그 대가로 전송 도중 실행이 끊기고 Discord도 받지 못한 알림은 빠집니다. 다음 실행부터 로그에 `전송 확인 안 된 알림(sending=1)` 경고가 찍힙니다. 확인하고 정리하는 쿼리:

```bash
npx wrangler d1 execute yeobee-ios-webhook-events --remote -c wrangler.play.jsonc --command "SELECT * FROM play_releases WHERE sending = 1"
```

```bash
npx wrangler d1 execute yeobee-ios-webhook-events --remote -c wrangler.play.jsonc --command "UPDATE play_releases SET sending = 0, previous_state = NULL WHERE sending = 1"
```

반다라트는 D1 이름을 `bandalart-ios-webhook-events`로 바꿉니다.

로그는 `npx wrangler tail play-release-ping`으로 봅니다. 정상 실행은 `Play checked=4 notifications=0 skipped=0`처럼 찍힙니다(두 앱 × 두 트랙의 활성 versionCode 수).

## 처음 배포하기

로컬 launchd와 Worker를 동시에 켜면 같은 전환이 두 번 알려집니다. 로컬을 먼저 끄고, 그 시점의 상태 파일로 D1을 채운 뒤 Worker를 켭니다.

0. 계정의 Cron Trigger 수가 한도(무료 5개) 안인지 확인합니다. 이 Worker가 1개를 더 씁니다.

1. 로컬 감시 두 개를 중지하고 plist를 보관합니다:

   ```bash
   launchctl bootout gui/$(id -u)/com.mps-jihun-lee.play-review-ping
   ```

   ```bash
   launchctl bootout gui/$(id -u)/com.easyhooon.bandalart.play-review-ping
   ```

   ```bash
   mkdir -p ~/Library/LaunchAgents/disabled && mv ~/Library/LaunchAgents/com.mps-jihun-lee.play-review-ping.plist ~/Library/LaunchAgents/com.easyhooon.bandalart.play-review-ping.plist ~/Library/LaunchAgents/disabled/
   ```

2. 중지한 뒤의 상태 파일로 seed SQL을 만듭니다:

   ```bash
   node --import tsx src/play-state-cli.ts seed .data/state.json com.yeobee > /tmp/yeobee-play-seed.sql
   ```

   ```bash
   node --import tsx src/play-state-cli.ts seed /Users/medi/Documents/Codex/BandalartAlerts/state/play.json com.nexters.bandalart > /tmp/bandalart-play-seed.sql
   ```

3. 테이블을 만듭니다. 여비 D1은 마이그레이션 기록이 있어 `0003`만 적용됩니다:

   ```bash
   npx wrangler d1 migrations apply yeobee-ios-webhook-events --remote -c wrangler.play.jsonc
   ```

   반다라트 D1은 `0001`을 마이그레이션 기록 없이 만들어서 `migrations apply`가 `0001`부터 다시 실행하다 실패합니다. `0003`만 직접 적용합니다:

   ```bash
   npx wrangler d1 execute bandalart-ios-webhook-events --remote -c wrangler.play.jsonc --file migrations/0003_play_releases.sql
   ```

4. seed를 넣습니다(테이블이 비어 있을 때만 성공합니다):

   ```bash
   npx wrangler d1 execute yeobee-ios-webhook-events --remote -c wrangler.play.jsonc --file /tmp/yeobee-play-seed.sql
   ```

   ```bash
   npx wrangler d1 execute bandalart-ios-webhook-events --remote -c wrangler.play.jsonc --file /tmp/bandalart-play-seed.sql
   ```

5. 배포합니다:

   ```bash
   npx wrangler deploy -c wrangler.play.jsonc
   ```

6. 비밀값을 등록합니다. 값을 화면이나 명령줄 인수에 남기지 않고 stdin으로 넣습니다:

   ```bash
   npx wrangler secret put YEOBEE_GOOGLE_SERVICE_ACCOUNT_JSON -c wrangler.play.jsonc < /Users/medi/AndroidStudioProjects/YeoBee-Android/playstore/service-account-key.json
   ```

   ```bash
   grep '^DISCORD_WEBHOOK_URL=' .env | cut -d= -f2- | tr -d '\n' | npx wrangler secret put YEOBEE_DISCORD_WEBHOOK_URL -c wrangler.play.jsonc
   ```

   ```bash
   npx wrangler secret put BANDALART_GOOGLE_SERVICE_ACCOUNT_JSON -c wrangler.play.jsonc < /Users/medi/StudioProjects/Bandalart/playstore/service-account-key.json
   ```

   ```bash
   grep '^BANDALART_PLAY_WEBHOOK_URL=' /Users/medi/Documents/Codex/BandalartAlerts/play.env | cut -d= -f2- | tr -d '\n' | npx wrangler secret put BANDALART_DISCORD_WEBHOOK_URL -c wrangler.play.jsonc
   ```

   배포와 비밀값 등록 사이에 Cron이 돌면 빠진 비밀값 오류로 그 앱만 끝납니다. D1과 Discord는 건드리지 않습니다.

7. `npx wrangler tail play-release-ping`으로 첫 Cron이 `notifications=0`이고 오류가 없는지 확인합니다.

## 로컬로 되돌리기

Worker 장애가 길어질 때만 씁니다. 두 경로를 동시에 켜지 않습니다.

1. Worker의 Cron을 끕니다. 설정의 `"crons"`를 `[]`로 바꿔 `npx wrangler deploy -c wrangler.play.jsonc`로 배포하거나, `npx wrangler delete play-release-ping`으로 Worker를 지웁니다(D1은 남습니다). 한 앱만 되돌릴 때는 `PLAY_APPS`에서 그 앱을 빼고 배포합니다.
2. D1 상태를 로컬 상태 파일로 내보냅니다. Worker가 전환 후 본 상태를 로컬이 이어받아 같은 알림이 다시 나가지 않습니다:

   ```bash
   npx wrangler d1 execute yeobee-ios-webhook-events --remote -c wrangler.play.jsonc --json --command "SELECT * FROM play_releases" > /tmp/yeobee-play-d1.json
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

서비스 계정 키를 새로 발급했으면 6단계의 해당 앱 `secret put` 명령을 다시 실행합니다. 재배포는 필요 없습니다. 이전 키는 Google Cloud 콘솔에서 지웁니다.
