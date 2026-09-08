# 재부팅 후 Pi workspace 복원

## 사용법

```bash
vipi start                  # 실행 중이면 접속, 없으면 복원 후 접속
vipi start --detached       # SSH/자동화에서 화면 attach 없이 준비
vipi save                   # 지금 즉시 snapshot
vipi status                 # 저장된 세션 경로·복구 상태·경고 확인
vipi install-autostart      # macOS 로그인 후 자동 복원 등록
```

`~/.local/bin`을 PATH에 넣는다. 설치는 repo 루트의 `python3 scripts/setup.py --apply`가 `~/.local/bin/vipi`를 연결한다. 기존 설치에서 다른 설정을 재생성하고 싶지 않으면 `ln -s "$PWD/scripts/vipi" ~/.local/bin/vipi`만 실행한다(기존 파일이 있으면 먼저 확인).

이미 `base` 같은 tmux 작업 공간이 있다면 최초 한 번:

```bash
vipi start --session base --detached
vipi install-autostart
```

이후 `vipi start`는 저장된 `base`로 돌아간다. 기존 pane을 이동·종료하지 않는다. 신규 머신 기본 tmux 이름은 `vipi`다. tmux 안에서는 `switch-client`, 밖에서는 `attach-session`을 사용한다. 세션 이름은 영문·숫자·`_`·`-`만 허용한다.

## 보존되는 것

- Pi JSONL 대화 파일 경로와 세션 ID, 작업 디렉터리, 이름
- 활성 Pi 세션의 창 순서와 선택 세션
- 트리 표시 여부와 root; 진입 시 선택된 창에는 트리를 제공한다
- 기존 Pi JSONL에 저장된 모델·thinking·대화 분기 상태
- 독립된 45칸 세션 트리와 새 tmux pane

`vipi start`가 15초 간격 checkpoint watcher를 시작한다. watcher는 Pi에 키나 프롬프트를 보내지 않고 registry와 tmux metadata만 읽는다. OS file lock으로 같은 상태 디렉터리의 watcher와 restore를 직렬화한다. 저장은 `0600` 파일 + atomic rename + fsync 방식이다.

상태 파일은 **repo 밖**에 둔다:

```text
~/.local/state/vipi/workspace/workspace.json
~/.local/state/vipi/workspace/workspace.previous.json
~/.local/state/vipi/workspace/last-restore.json
~/.local/state/vipi/workspace/watch.log
```

대화 원본은 `~/.pi/agent/sessions/`에 남는다. manifest는 **대화 백업이 아니라 복원할 파일을 가리키는 목록**이다. 재부팅에는 남지만 디스크 고장·세션 파일 수동 삭제에 대비하려면 이 두 디렉터리를 별도로 안전하게 백업해야 한다. 마지막 15초의 창 구성 변경과 디스크에 아직 기록되지 않은 streaming 응답은 유실될 수 있다. 예정된 재부팅 전에는 작업을 마무리하고 `vipi save`를 실행한다.

## 일부러 복원하지 않는 것

- 기존 OS 프로세스·실행 중 bash/Python/모델 요청·미전송 프롬프트·메시지 큐
- tmux scrollback/임의 shell 명령/일반 개발 서버/SSH 연결
- 같은 JSONL을 동시에 연 중복 pane: 대화 파일당 한 개만 복원
- 저장 파일이 없는 임시/미사용/등록되지 않은 pane

복원은 `pi --session <검증된 파일>`만 실행하며 과거 pane 명령 문자열을 재생하지 않는다. 복원된 Pi-Vim은 NORMAL로 시작한다. 새 workspace의 첫 빈 Pi는 INSERT다. 트리의 신규 `n` 동작은 기존대로 INSERT다.

### 예약 작업 안전성

`pi-schedule-prompt`는 시작할 때 저장된 타이머를 다시 실행한다. 따라서 **복원으로 띄운 Pi는 `--no-extensions`와 전역 패키지의 명시적 `-e` 목록을 사용하고 scheduler를 제외**한다. 프로젝트 및 standalone `extensions/` 자동 검색도 비활성화된다. skills/themes 설정은 유지한다. 패키지 object/filter 설정은 자동 확대 적용하지 않고 설명과 함께 중단한다.

예약 작업을 재개하려면 작업 내용을 확인한 뒤 해당 대화를 일반 `pi --session <file>`로 다시 실행한다. 두 프로세스에서 같은 대화를 동시에 열지 않는다. 일반 tree `n`/dormant reopen은 기존 Pi 실행 방식이다. 임의의 제3자 extension이 수행하는 startup side effect까지 launcher가 통제하는 것은 아니므로 전역 패키지는 신뢰한 것만 설치한다.

## 복원 누락·실패

`vipi save`는 `recorded`와 `recoverable`을 구분한다. 복원 전에 파일 header의 ID와 cwd 존재 여부를 검증한다. 파일이 없으면 새 대화로 몰래 바꿔치기하지 않는다. 누락된 기록은 `pending`에 유지하고 다음 명시적 `vipi start`에서 재검사한다. `last-restore.json`에 오류를 저장한다.

Pi는 첫 assistant 응답 전에는 세션 파일을 아직 생성하지 않을 수 있다. 파일이 없다는 것만으로 대화가 유실됐다고 단정하면 안 된다. 오래된 live pane이 registry에 없을 때도 자동으로 다른 파일을 추측해 연결하지 않는다. 해당 Pi에서 `/session`으로 파일 경로와 ID를 확인하고 등록/저장을 점검한다. 중요한 대화가 `recoverable`에 들어오기 전에는 재부팅하지 않는다.

서버가 사라졌거나 registry가 준비되지 않은 동안 빈 snapshot으로 마지막 정상 목록을 덮어쓰지 않는다. 따라서 모든 창을 의도적으로 닫아도 마지막 non-empty workspace는 다음 `start`의 복원 후보로 남는다.

## 로그인 자동 시작 / 해제

LaunchAgent: `~/Library/LaunchAgents/dev.vipi.workspace.plist`. 로그인 시 `vipi watch`가 한번 복원하고 이후 checkpoint만 한다. 사용자가 실행 중 모든 창을 닫았다고 반복 재실행하지는 않는다. `vipi start`로 다시 연다.

현재 GUI domain에 접근하지 못하면 plist 생성만 성공하고 즉시 등록은 실패할 수 있다. 이때 CLI가 실패를 표시한다. 수동 `vipi start`와 watcher는 별개로 사용 가능하다. FileVault 최초 잠금 해제 **전**에는 사용자 Pi를 복원할 수 없다.

해제:

```bash
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.vipi.workspace.plist"
rm "$HOME/Library/LaunchAgents/dev.vipi.workspace.plist"
```

수동으로 시작한 watcher는 별도 프로세스일 수 있다. `ps`로 **정확한 `scripts/vipi watch` PID**를 확인한 뒤 해당 watcher만 종료한다. Pi/tmux server를 죽여 watcher를 종료하지 않는다. repo를 옮기면 symlink와 LaunchAgent를 새 경로에서 다시 설치한다.

## 검증

```bash
python3 scripts/test-workspace.py
python3 scripts/test-workspace-tui.py
```

첫 테스트는 disposable HOME/state와 전용 tmux socket에서 모의 Pi 프로세스로 중복 방지·server loss·재복원·부분 실패 보존을 검증한다. 두 번째는 실제 Pi와 로컬 확장을 offline 상태로 띄워 세션 재개·NORMAL·registry·45칸 트리를 확인한다. API 호출/메시지 전송은 하지 않는다. 테스트의 `kill-server`는 UUID로 만든 **테스트 socket에만** 적용된다. 실제 macOS 재부팅/FileVault/launchd 로그인 복원 E2E는 별도 검증이 필요하다.
