# Codex 계정 2개 + 자동 전환

Pi **0.84.2**의 native provider / OAuth / CredentialStore를 그대로 사용한다. 별도 OAuth 구현, 토큰 복사, 공용 인증파일 바꿔치기는 없다.

## 로그인

새 Pi 또는 작업이 끝난 기존 Pi에서 `/reload` 후:

```text
/login openai-codex-2
/codex-accounts
```

- 계정 1은 기존 `openai-codex` 로그인이다. 다시 로그인할 필요 없다.
- 계정 2는 브라우저에서 **다른 ChatGPT 계정**으로 승인한다. 같은 계정이면 저장 전에 거부한다.
- OAuth의 브라우저 callback/paste-code 흐름은 Pi 기본 UI를 사용한다. 두 로그인 과정을 동시에 시작하지 않는다(기본 callback 포트 공유).
- 계정 1 재인증: `/login openai-codex`. 계정 2 해제: `/logout`에서 `Codex 계정 2` 선택.
- 모델은 계속 `openai-codex/gpt-6-astra`를 선택한다. 계정 2 provider는 로그인 슬롯이며 별도 모델 목록을 만들지 않는다.

아래 바 예시:

```text
NORMAL                      first@example.com | Usage 45% Left
Thinking: high             second@example.com | Usage 90% Left
```

왼쪽은 Vim 상태와 그 아래 Thinking, 오른쪽 두 줄은 계정별 이메일과 **남은 사용량**이다. 현재 Pi 프로세스가 마지막으로 요청을 보낸 계정은 더 밝게 표시한다. 계정 2 로그인 전에는 `account2 not connected`로 표시한다. 이메일은 OAuth access token의 profile claim에서 읽으며 사용량 캐시에 저장하지 않는다. 이메일을 얻지 못하면 `account1` / `account2`로 표시한다. footer는 주간 잔여량을 우선 표시하고 주간 창이 없으면 가장 긴 창을 사용한다. `~`는 오래되었거나 조회에 실패한 마지막 값이고, reset 시각이 지났으면 `checking...`으로 표시한다. `/codex-accounts`는 새 조회를 시도하고 제공된 5시간·주간 창의 잔여량과 초기화 시각도 보여준다(명령 출력의 `*`가 현재 계정). 잔여량은 실시간 보장이 아니라 최근 서버 관측값이다.

## 전환 규칙

1. 현재 계정을 유지한다. 사용량이 확실히 소진된 경우에만 다른 연결 계정을 선택한다.
2. HTTP 429와 함께 한도 헤더 또는 사용량 조회에서 **실제 소진이 확인**되면, 아직 start/content/tool-call 이벤트를 하나도 전달하지 않은 요청만 다른 계정으로 한 번 재시도한다.
3. 보통의 속도 제한, 네트워크 오류, 인증 오류, 정책 거절, 모델 미지원은 계정 전환 사유가 아니다. 취소 요청도 재시도하지 않는다.
4. 이미 streaming이 시작됐으면 계정을 바꿔 처음부터 생성하지 않는다. Pi 도구/명령/배포는 이 확장이 실행하거나 재실행하지 않는다.
5. 두 계정 모두 소진되면 오류를 표시하고 멈춘다. 무한 round-robin하지 않는다.
6. 새 Pi 프로세스는 계정 1부터 시작하되 저장된 quota가 아직 소진 상태면 계정 2를 사용한다. 이미 전환된 프로세스는 계정 2를 유지한다.

계정이 바뀌어도 모델·thinking·대화는 유지한다. 모델 요청은 SSE로 전송한다. 계정별 request session ID와 assistant provider provenance를 분리해 native Pi의 cross-provider 메시지 변환이 다른 계정의 encrypted reasoning signature를 그대로 재전송하지 않도록 한다. 대화 내용은 선택된 두 계정 각각으로 전송될 수 있으므로, 둘 다 본인이 해당 대화를 처리하도록 승인한 계정이어야 한다.

Spark의 별도 quota를 일반 Codex quota와 혼동하지 않도록 Spark에는 일반 사용량 기반 사전 전환을 적용하지 않는다. 해당 요청의 quota 헤더가 확인되는 경우에만 전환한다. 다른 특수 모델의 별도 한도까지 지원한다고 가정하지 않는다.

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
```

오프라인 테스트는 소진/초기화/오래된 캐시, quota에서만 1회 전환, streaming 후·취소 시 재실행 금지, 두 토큰 분리, 중복 계정 거부, 두 계정 footer, thinking 보존을 검증한다. 실제 두 계정 로그인과 한도 소진 E2E는 별도로 확인해야 한다. 한도를 테스트하려고 실제 사용량을 소진하지 않는다.

해제하려면 settings의 `packages/pi-codex-accounts` 항목을 제거하고 새 Pi를 시작한다. 기본 Codex 계정 1과 legacy footer로 돌아간다. 계정 2 로그인을 제거하려면 확장이 로드된 상태에서 먼저 `/logout`을 사용한다. 인증·사용량 캐시는 공개 repo에 커밋하지 않는다.
