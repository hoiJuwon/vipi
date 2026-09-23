# Codex 계정 2개 + 자동 전환

Pi **0.84.2**의 native provider / OAuth / CredentialStore를 그대로 사용한다. 별도 OAuth 구현, 토큰 복사, 공용 인증파일 바꿔치기는 없다.

## 로그인

새 Pi 또는 작업이 끝난 기존 Pi에서 `/reload` 후:

```text
/login openai-codex-2
/codex-accounts
```

- 계정 1은 기존 `openai-codex` 로그인이다. 다시 로그인할 필요 없다.
- 예전 `vipi start`로 복원한 프로세스는 CLI의 확장 목록이 고정돼 있다. settings에 계정 패키지가 활성화돼 있는데 `/reload` 후에도 누락된 경우, footer가 계정 provider·명령·사용량 폴링을 함께 설치한다. 현재 사용량 publisher에 이벤트로 응답을 요청해 살아 있는지 확인하며, 응답이 있으면 중복 설치하지 않는다. reload 후 남은 provider 등록만으로 정상 로드됐다고 판단하지 않는다.
- 계정 2는 브라우저에서 **다른 ChatGPT 계정**으로 승인한다. 같은 계정이면 저장 전에 거부한다.
- OAuth의 브라우저 callback/paste-code 흐름은 Pi 기본 UI를 사용한다. 두 로그인 과정을 동시에 시작하지 않는다(기본 callback 포트 공유).
- 계정 1 재인증: `/login openai-codex`. 계정 2 해제: `/logout`에서 `Codex 계정 2` 선택.
- 모델은 계속 `openai-codex/gpt-6-astra`를 선택한다. 계정 2 provider는 로그인 슬롯이며 별도 모델 목록을 만들지 않는다.

아래 바 예시:

```text
NORMAL                      first@example.com | Usage 45% Left
gpt 6 astra High           second@example.com | Usage 90% Left
```

왼쪽은 Vim 상태와 그 아래 현재 모델·thinking 강도, 오른쪽 두 줄은 계정별 이메일과 **남은 사용량**이다. 현재 Pi 프로세스가 마지막으로 요청을 보낸 계정은 더 밝게 표시한다. 계정 2 로그인 전에는 `account2 not connected`로 표시한다. 이메일은 OAuth access token의 profile claim에서 읽으며 사용량 캐시에 저장하지 않는다. 이메일을 얻지 못하면 `account1` / `account2`로 표시한다. footer는 주간 잔여량을 우선 표시하고 주간 창이 없으면 가장 긴 창을 사용한다. `~`는 오래되었거나 조회에 실패한 마지막 값이고, reset 시각이 지났으면 `checking...`으로 표시한다. `/codex-accounts`는 새 조회를 시도하고 제공된 5시간·주간 창의 잔여량과 초기화 시각도 보여준다(명령 출력의 `*`가 현재 계정). 잔여량은 실시간 보장이 아니라 최근 서버 관측값이다.

## 우선 계정 변경

```text
/codex-accounts use 2
/codex-accounts use 1
```

연결된 계정만 선택할 수 있다. 선택은 `codex-accounts/preference.json`에 `0600`으로 저장되며 새 세션과 재시작 후에도 유지된다. 변경된 코드를 로드한 기존 세션도 **다음 모델 요청부터** 새 선택을 확인한다. 진행 중인 요청은 취소하거나 재실행하지 않는다. 구버전이 실행 중이면 먼저 `/reload`한다. 우선 계정이 소진됐다면 다른 계정으로 자동 전환하는 규칙은 그대로다.

## 전환 규칙

1. 현재 계정을 유지한다. 사용량이 확실히 소진된 경우에만 다른 연결 계정을 선택한다.
2. HTTP 429와 함께 한도 헤더 또는 사용량 조회에서 **실제 소진이 확인**되면, 아직 start/content/tool-call 이벤트를 하나도 전달하지 않은 요청만 다른 계정으로 한 번 재시도한다.
3. 보통의 속도 제한, 네트워크 오류, 인증 오류, 정책 거절, 모델 미지원은 계정 전환 사유가 아니다. 취소 요청도 재시도하지 않는다.
4. 이미 streaming이 시작됐으면 계정을 바꿔 처음부터 생성하지 않는다. Pi 도구/명령/배포는 이 확장이 실행하거나 재실행하지 않는다.
5. 두 계정 모두 소진되면 오류를 표시하고 멈춘다. 무한 round-robin하지 않는다.
6. 새 Pi 프로세스는 저장된 우선 계정부터 시작한다(선택 이력이 없으면 계정 1). 소진 후 자동 전환한 프로세스는 해당 계정을 유지하되, 사용자가 다시 `use 1|2`로 지정하면 다음 요청부터 그 선택을 우선한다.

계정이 바뀌어도 모델·thinking·대화는 유지한다. 모델 요청은 SSE로 전송한다. 계정별 request session ID와 assistant provider provenance를 분리해 native Pi의 cross-provider 메시지 변환이 다른 계정의 encrypted reasoning signature를 그대로 재전송하지 않도록 한다. 대화 내용은 선택된 두 계정 각각으로 전송될 수 있으므로, 둘 다 본인이 해당 대화를 처리하도록 승인한 계정이어야 한다.

Spark의 별도 quota를 일반 Codex quota와 혼동하지 않도록 Spark에는 일반 사용량 기반 사전 전환을 적용하지 않는다. 해당 요청의 quota 헤더가 확인되는 경우에만 전환한다. 다른 특수 모델의 별도 한도까지 지원한다고 가정하지 않는다.

## Bad Request 자동 재시도

응답 본문이 정확히 `{"detail":"Bad Request"}`인 모호한 실패는 **같은 계정·같은 모델 요청으로 즉시 최대 2회 재시도**한다(최초 포함 최대 3회). 중간 실패는 바깥 agent에 전달하지 않아 도구 작업 흐름이 즉시 끊기지 않는다. 계속 실패하면 재시도 횟수를 표시하고 멈춘다. 계정 소진 전환과 별도이며 이 오류 때문에 계정을 바꾸지 않는다.

아직 start/content/tool-call 이벤트를 하나도 내보내지 않았고 실패 응답에도 부분 출력이 없어야 한다. 취소 및 확인된 HTTP 401/403/429는 이 규칙으로 재시도하지 않는다. 다른 명시적인 인증·정책·모델 오류를 일반 Bad Request로 취급하지 않는다. 완료한 도구 결과가 포함된 동일 context를 다시 전송할 뿐, 파일 변경·명령·배포·이미지 생성 도구를 다시 실행하지 않는다.

계정 2 alias로 직접 복원된 요청도 같은 라우터를 거친다. 코드 수정만으로 실행 중 프로세스가 바뀌지는 않으며, 기존 Pi는 작업이 끝난 뒤 `/reload`해야 적용된다.

## 저장·동시성

인증은 기본 `auth.json`의 서로 다른 provider 키에 저장한다. Pi의 기본 `CredentialStore.modify()`가 cross-process file lock 아래 refresh-token 갱신을 처리한다. 기존 계정 1의 인증 구조는 그대로다. 계정 1 OAuth 자체가 만료 후 갱신 불가능하면 Pi 외부 인증 단계에서 멈출 수 있으며 재로그인이 필요하다. 이 확장은 인증 실패를 우회하지 않는다.

비밀이 아닌 사용량 캐시:

```text
~/.pi/agent/codex-accounts/1.json
~/.pi/agent/codex-accounts/2.json
```

경로는 `PI_CODING_AGENT_DIR`를 따른다. 파일은 `0600`, 디렉터리는 `0700`으로 만들고 atomic rename한다. 계정 ID는 해시로만 저장한다. 계정 변경 시 이전 계정의 캐시를 무시한다. 캐시는 advisory last-writer-wins이며 인증 원본이 아니다.

`https://chatgpt.com/backend-api/wham/usage`의 읽기 전용 GET으로 두 계정을 조회한다. 여러 세션이 있어도 계정별 poll lease와 캐시로 대체로 60초마다 한 번만 조회한다(세션은 15초마다 캐시 확인). 수동 갱신과 quota 확인은 더 자주 조회할 수 있다. endpoint가 실패/변경되면 조회 실패로 표시하며 사용량을 추측하지 않는다. 모델 답변 요청은 사용량 조회 목적으로 만들지 않는다.

## 검증·해제

```bash
node scripts/test-codex-accounts.mjs
python3 scripts/test-workspace-tui.py
python3 scripts/test-workspace-tui.py --legacy-cli
```

TUI 테스트는 일반 실행과 구형 CLI 확장 목록 양쪽에서 연속 두 번 `/reload`해도 두 계정 행이 유지되는지 확인한다. Bad Request 테스트는 같은 계정 재시도 후 복구, 3회 총 시도 제한, 중간 error 차단, 원래 context 유지, 계정 2 직접 호출, 부분 출력·취소·401/403/429의 재시도 차단을 검증한다. 오프라인 테스트는 소진/초기화/오래된 캐시, quota에서만 1회 전환, streaming 후·취소 시 재실행 금지, 두 토큰 분리, 중복 계정 거부, 두 계정 footer, thinking 보존을 검증한다. 실제 두 계정 로그인과 한도 소진 E2E는 별도로 확인해야 한다. 한도를 테스트하려고 실제 사용량을 소진하지 않는다.

해제하려면 settings의 `packages/pi-codex-accounts` 항목을 제거하고 새 Pi를 시작한다. 기본 Codex 계정 1과 legacy footer로 돌아간다. 계정 2 로그인을 제거하려면 확장이 로드된 상태에서 먼저 `/logout`을 사용한다. 인증·사용량 캐시는 공개 repo에 커밋하지 않는다.
