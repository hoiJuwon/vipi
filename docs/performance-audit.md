# Vipi 성능·트리 수명주기 점검 (2026-09-18)

## 결론

이번 버벅임의 가장 뚜렷한 vipi 측 원인은 **부모를 잃은 Neovim tree worker가 종료 중에도 갱신을 반복하는 문제**다. 이미지 생성이나 이미지 렌더링 부하를 줄이는 것으로 대신 해결하지 않았다. 정상 Pi·이미지 작업·터미널 클라이언트는 종료하지 않았다.

조사 범위: `pi-session-tree` 전체 Lua/TS, registry/catalog 저장 흐름, Pi-Vim 상태 발행 연결, footer/account/activity 타이머, REVIEW/대화 탐색, sidebar resize hook, `scripts/vipi` snapshot/restore. 외부 MCP·Pi/Neovim/iTerm 내부 전체와 private iOS 앱까지 전수 검증한 것은 아니다.

## 실측

- 조사 중 실제 pane에 속하지 않는 `nvim --embed .../pi-session-tree/tree.lua`, PPID 1인 프로세스 **17개** 확인. CPU 합계 **180.5%**(한 코어=100%). 도중 다른 창도 닫혀 사용자가 제시한 11개보다 늘어난 상태였다.
- 한 잔류 worker를 `sample`로 확인: `nlua_error → wait_return → exit_event → preserve_exit → os_exit → nlua_schedule_event → Lua/vim.wait` 경로. 종료와 오류 처리 중 예약된 갱신이 다시 실행되고 있었다.
- 정확한 명령·부모 PID·pane PID를 대조한 잔류 worker만 TERM. 모두 종료되지 않아 같은 PID/명령을 재검증한 뒤 KILL했다.
- 정리 후 잔류 worker **0개**. 수정된 실제 트리 3개(terminal UI 부모+embed worker=프로세스 6개)의 CPU 합계 한 측정에서 **1.2%**, tmux **0.5%**. 처음 tmux는 약 **29%**였다.
- 이후 시스템 CPU idle **70.85~73.22%** 관측. 이는 작업량과 열린 창 수가 달라지는 시점의 관측값이며, 전체 개선량을 코드 수정만의 효과라고 해석하면 안 된다. iTerm/WindowServer는 이후에도 CPU를 사용했다.

### 동일 조건 격리 비교

구버전과 수정본을 각각 같은 disposable tmux socket/Neovim/45칸/idle 세션 1개로 실행했다. tmux wrapper로 실제 subprocess 실행 횟수, Neovim `changedtick`으로 buffer write를 측정했다. 각 구간 약 5.1초. 모델 호출 없음.

| 상태 | 구버전 tmux 호출 | 수정본 | 구버전 buffer write | 수정본 |
|---|---:|---:|---:|---:|
| 보이는 idle 트리 | 82 | 20 | 20 | 0 |
| 숨겨진 idle 트리 | 87 | 2 | 21 | 0 |

이 조건에서 tmux 호출은 약 **76% / 98% 감소**했다. 1개 row의 worker CPU는 visible 약 0.97→0.59%, hidden 0.78→측정 해상도상 0%였으며, 대규모 목록이나 실제 작업 전체의 성능 보장치는 아니다.

## 발견·수정한 문제

### P0: 종료 중 갱신 재진입과 orphan

`tree.lua`의 기존 `uv.new_timer + vim.schedule_wrap`은 일정마다 콜백을 계속 큐에 넣었다. 콜백 안에서 동기 `vim.system(...):wait()`가 event loop를 돌리고, 종료 시 정리는 늦은 `VimLeavePre`에만 있었다. 오류/종료 경로에서 같은 작업이 다시 실행될 수 있었다.

수정:
- 초기 IO **전** `VimLeavePre`, `UILeave`, `BufWipeout` cleanup 등록.
- closing/exiting/dying 상태와 buffer 유효성 검사.
- 타이머 중지뿐 아니라 이미 예약된 callback의 작업도 차단하고 진행 중 snapshot subprocess 취소.
- 최초 parent PID를 추적. parent가 바뀌면 scratch tree process를 직접 종료해 터미널 UI가 SIGKILL된 경우도 회수.
- scheduled/in-flight/busy 플래그로 queued tick 중복·poll 중첩·사용자 action 중 재진입 차단.
- 백그라운드 오류를 hit-enter prompt로 만들지 않는다. 짧은 statusline에 실패를 표시하고 최근 오류는 `vim.g.pi_tree_last_error`에 보관한다.

### P1: 동기 subprocess 폭증 / 숨겨진 창의 지속 갱신

기존 루프는 owner, active pane, navigation, permission, live pane 등을 서로 다른 tmux 호출로 조회했다. 세션 tab 이동도 owner 조회를 row 루프에서 호출했다. 숨겨진 창도 같은 속도로 갱신했다.

수정:
- 주기 갱신은 **단일 비동기 `list-panes` snapshot**. owner/visibility/permission/navigation/live 정보 함께 수집.
- visible 최대 250ms, hidden 2초 간격. hidden은 snapshot만 확인하고 목록은 다시 만들거나 그리지 않는다.
- tmux 조회 timeout 800ms. 실패하면 마지막 화면을 보존하고 다음 poll에서 재시도.
- 사용자가 명령을 실행하는 경로의 동기 호출은 남겼지만, 이름 입력/confirm/전환 대기 중 periodic refresh가 끼어들지 않는다.
- 폭이 이미 45칸이면 resize 명령을 다시 보내지 않는다.

트리 프로세스 하나씩은 유지한다. 기존 창별 안정된 레이아웃을 없애거나 `join-pane`으로 옮기며 화면을 다시 reflow하는 방식은 택하지 않았다. 숨긴 창을 다시 보였을 때 상태 반영은 최대 약 2초 늦을 수 있다. 키 선택 자체는 즉시 반영한다.

### P1: 전체 buffer/강조/커서 덮어쓰기

idle 상태에서도 250ms마다 전체 `nvim_buf_set_lines`, 전체 namespace clear, cursor 이동을 수행했다.

수정:
- 출력과 스타일이 동일하면 **buffer/highlight/cursor 쓰기 없음**.
- spinner나 상태가 달라진 row만 변경.
- 바뀐 row와 이전/새 선택 row의 강조만 갱신.
- 커서가 같은 row이면 이동하지 않는다. 키 이동은 timer를 기다리지 않고 선택 상태를 바로 반영.

### P1: 읽기용 트리가 공유 registry의 writer로 동작

각 트리가 `working → idle`, unread를 자체 추정한 뒤 병합된 전체 registry를 다시 저장했다. 여러 트리가 같은 상태를 놓고 경쟁하며 Pi의 최신 상태를 덮을 가능성이 있었다.

수정: **주기 refresh에서는 registry를 쓰지 않는다.** Pi가 작업/unread lifecycle의 주체다. 명시적인 읽음/이름변경/삭제 등 사용자 action의 쓰기만 유지했다.

부수적으로 JSONL이 아직 flush되지 않은 정상 live/new session을 숨기던 조건도 수정했다. 아직 저장되지 않은 세션의 삭제는 Pi를 먼저 죽이지 않고 경고한다.

### P2: 상태 변경이 없는 반복 IO/render

- Pi-Vim status event마다 tmux를 spawn하던 경로: 상태가 바뀔 때만 발행, 한 번에 하나씩 순서 보장. 빠른 INSERT/NORMAL 이벤트의 쓰기 순서도 보존.
- account usage: 같은 표시 데이터의 반복 emit 제거, 느린 tick 중복 실행 차단. reload handshake는 강제 응답을 유지해 이전 footer 복구 동작을 깨지 않는다.
- footer/activity: 동일한 표시 문자열이면 render 요청 생략. activity는 idle 때 기존대로 timer를 닫는다.
- workspace checkpoint: 레이아웃/선택/복원 정보가 같으면 snapshot 두 파일의 rewrite/fsync 생략. Pi 대화는 기존 JSONL에 별도로 저장된다. `savedAt`은 마지막 구성 변경 저장 시각이지 대화의 마지막 저장 시각이 아니다.

## 아직 남은 위험 / 후속 우선순위

| 우선순위 | 항목 | 현재 판단 |
|---|---|---|
| P1 | registry/catalog 전체 JSON read-modify-write | atomic rename은 파일 손상만 방지하고 프로세스 간 lost update는 막지 못한다. polling writer는 제거했지만 Pi 등록과 수동 rename/delete 사이의 동시 쓰기는 여전히 남는다. 단일 writer 또는 양 언어 공통 transaction/lock이 후속 과제다. 현재 세션 원본을 마이그레이션하며 즉석에서 갈아엎지는 않았다. |
| P2 | `watchUntilRead()`의 세션별 1초 tmux 조회 | unread Pi마다 별도 조회한다. 정상 idle/읽은 Pi에는 timer가 없지만 unread 세션이 많으면 호출이 늘어난다. 현재 주원인으로 실측된 것은 아니다. |
| P2 | 수동 open/reopen의 동기 handshake | 지속적인 UI freeze는 제거했지만 최초 Pi startup/트리 준비에는 bounded wait가 남는다. 비동기 action 흐름으로 바꾸는 것은 별도 회귀 테스트가 필요한 작업이다. |
| P2 | 창 수에 비례하는 hidden snapshot | hidden tree 1개당 약 0.5회/초는 남는다. 수십~수백 개 창이면 공통 snapshot publisher 또는 tmux event subscription이 다음 단계다. |
| P2 | 복원 launcher의 CLI 확장 whitelist | 예약 작업을 자동 재실행하지 않는 장점 대신 새 패키지 추가가 기존 프로세스 `/reload`에 반영되지 않을 수 있다. 계정 확장의 handshake 보완은 유지했으며 이번 성능 수정에서 scheduler를 다시 활성화하지 않았다. |
| 관측 | 큰 대화·inline image 렌더링 / iTerm / WindowServer | 정당한 작업 부하와 vipi의 낭비를 구분해야 한다. 이번 수정은 이미지 작업을 제한하지 않았다. 큰 대화의 Pi 내부 render 비용은 별도 profiling 범위다. 트리는 매 tick마다 전체 세션 4GiB를 읽는 것이 아니라 약 22KiB registry와 catalog를 읽는다. |

REVIEW와 대화 탐색에는 지속 poll을 발견하지 않았다. 명시적 키 입력에만 subprocess를 실행하므로 이번 idle 폭주 원인과 구분했다. 전면적으로 "모든 버그 해결"이라고 보고하지 않는다.

## 적용 및 검증

실제 tree pane만 같은 pane ID/45칸 폭으로 재시작해 핵심 수명주기·polling 변경을 적용했다. Pi process와 이미지 작업, 대화 원본은 그대로다. Pi 쪽 status/footer/activity 중복 제거는 **각 Pi가 idle일 때 `/reload`**하면 반영된다. 실행 중 모델 요청에 강제로 키를 보내지 않았다. snapshot의 작은 IO 개선은 watcher가 다음에 재시작할 때 반영된다.

```bash
python3 scripts/test-tree-lifecycle.py
node scripts/test-session-title.mjs
node scripts/test-codex-accounts.mjs
python3 scripts/test-workspace-tui.py
python3 scripts/test-workspace-tui.py --legacy-cli
python3 scripts/test-workspace.py
python3 scripts/test-setup.py
python3 scripts/check.py
python3 scripts/setup.py  # dry run
```

핵심 회귀: idle changedtick 유지, polling 중 registry 불변, unsaved live row, permission PID 생존 검사, rename prompt 중 buffer 불변, 느린 tmux에서도 RPC/input 응답, hidden throttling, q/kill-pane/render-error+kill/TUI-parent SIGKILL/server 종료 후 orphan 없음. 테스트는 UUID로 분리한 socket/HOME에서 수행하고 실제 default tmux server를 죽이지 않는다. 구버전/신버전 benchmark는 별도 임시 fixture에서 수행했다.
