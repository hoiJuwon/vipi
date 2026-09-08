# Vipi — Pi host configuration + iOS client

macOS에서 쓰는 Pi 터미널 환경을 재현하는 저장소다. **코드·설정만 저장하며 인증정보나 대화는 저장하지 않는다.** `vipi-ios/`는 [private iOS/host 저장소](https://github.com/hoiJuwon/vipi-ios)의 특정 커밋을 가리키는 서브모듈이다.

에이전트는 먼저 [AGENTS.md](AGENTS.md)를 읽는다. 아래 명령은 별도 표기가 없으면 이 저장소 루트에서 실행한다.

## 1. 처음 설치

### 전제

- macOS, Homebrew, Git, Python 3, Node/npm, tmux, Neovim.
- 검증 기준: Pi `0.84.2`, Node `23.10.0`. Node 다른 버전·Pi 최신 버전은 별도 회귀 검사가 필요하다.
- Astra를 사용할 수 있는 OpenAI Codex 계정. ChatGPT 앱 접근 권한과 Pi provider 권한은 별도 확인한다.
- 원격 접속 시 Tailscale/SSH. iOS 클라이언트 빌드 시 Xcode, signing 권한, private 서브모듈 접근 권한.

```bash
brew install git node python tmux neovim
npm install -g @earendil-works/pi-coding-agent@0.84.2
git clone https://github.com/hoiJuwon/vipi.git ~/vipi
cd ~/vipi
# GitHub private repo 접근 인증이 되어 있어야 성공한다.
git submodule update --init --recursive
cp machine.example.json machine.local.json
```

`machine.local.json`의 Tailscale IP, MacBook SSH alias, 원격 hostname을 실제 값으로 수정한다. 이 파일은 Git에서 제외된다. 원격 Mac을 사용하지 않으면 해당 이미지 복구 기능은 사용하지 않는다.

> 공개 저장소만 접근 가능한 사용자는 private 서브모듈을 받을 수 없다. 호스트 전용으로 사용하려면 `pi/settings.json`의 `@VIPI_IOS@` 패키지를 제거한 뒤 설치한다. 인증 없이 전체 모바일 환경을 재현할 수 있다고 가정하지 않는다.

### 검토 → 적용

```bash
python3 scripts/check.py
python3 scripts/setup.py                 # dry run: 대상 경로만 출력
python3 scripts/setup.py --apply         # 기존 파일을 백업하고 설정 적용
pi                                      # npm/git 패키지 자동 설치; 완료되면 종료
sh scripts/patch-mcp.sh                  # MCP 권한 대기 상태 패치 적용
# tmux server가 실행 중일 때만:
tmux source-file ~/.tmux.conf
```

설치 동작:
- 각 커스텀 extension/theme/style을 `~/.pi/agent/`에서 이 저장소로 **symlink**한다. 이후 repo 수정이 곧 로컬 수정이다.
- 기본 설정은 `~/.pi/agent/settings.json`에 병합한다. 관련 기본값은 덮어쓰고 관계없는 패키지는 유지한다.
- `AGENTS.md`, `.tmux.conf`, Ponytail 설정은 템플릿에서 생성한다. 기존 사용자 규칙이 있으면 백업과 비교해 필요한 내용을 템플릿에 병합한다.
- 백업: `~/.local/state/vipi/backups/<timestamp>/`. **삭제하지 말고 적용 검증 후 보관한다.**
- MCP 설정·로그인·세션 데이터는 변경하지 않는다. 기존 프로세스를 종료하거나 `/reload`를 강제로 보내지 않는다.

기존 `~/vipi-ios` host 서비스가 실행 중인 머신에서는 경로를 유지할 수 있다:

```bash
python3 scripts/setup.py --apply --ios-path "$HOME/vipi-ios"
```

이 옵션은 실행 경로만 유지한다. 배포된 iOS checkout의 커밋이 서브모듈 포인터와 같은지는 따로 확인한다. 현재 주 머신은 이 방식으로 기존 서비스를 보존했다.

### 로그인 및 적용 확인

Pi 안에서 `/login` → `openai-codex`. `/model`에서 `gpt-6-astra` 선택 가능 여부를 확인한다. 기본값은 **Astra / medium**이다. 계정에 모델이 없다면 모델 목록 갱신이나 provider 접근 확인이 먼저이며 ID를 추가한다고 권한이 생기지 않는다.

```bash
pi list
pi --list-models astra
# 선택 사항: 실제 모델 호출 (사용량 발생)
pi --model openai-codex/gpt-6-astra --thinking medium -p --no-session 'Reply only OK.'
```

열려 있던 Pi는 사용자가 유휴 상태에서 `/reload`한다. 새 세션은 새 설정을 읽는다. 기존 대화에 저장된 모델/모드는 새 기본값과 다를 수 있다.

## 재부팅 후에도 같은 작업 공간으로 들어가기

```bash
vipi start                         # 기존 tmux 접속 / 없으면 Pi 대화 + 트리 복원
vipi save                          # 즉시 저장 (평소에는 15초마다 자동 저장)
vipi status                        # 복구 가능 세션과 누락 확인
vipi install-autostart             # macOS 로그인 시 자동 복원 등록
```

최초 기존 `base`를 채택하려면 `vipi start --session base --detached`. `~/.local/bin`이 PATH에 있어야 한다. **실행 중 명령과 미전송 입력은 복원하지 않으며, 저장 파일이 없는 pane은 경고한다.** 복원 시 예약 프롬프트의 자동 실행을 막기 위해 scheduler와 프로젝트 확장 자동 로딩을 제외한다. 사용법·저장 경로·복구 누락·FileVault·자동 시작 해제·테스트는 [workspace 가이드](docs/workspace.md)를 읽는다.

## 2. 포함된 동작

| 영역 | 설정 |
|---|---|
| 모델 | `openai-codex/gpt-6-astra`, thinking `medium`, reasoning block 숨김, SSE |
| TUI | `regular`, tmux scrollback 유지, Vim 테마 |
| 입력 | 어두운 borderless 배경, 위아래 padding, 초록색 `  > `, INSERT에서만 cursor |
| 모드 | 신규 tree `n` 세션은 INSERT, 정상 제출 후 NORMAL, 기존 세션 활성화는 NORMAL |
| 리뷰 | NORMAL의 `R`만 tmux snapshot REVIEW; Esc는 live NORMAL |
| 탐색 | `:e .` 세션 tree, `gt/gT` 이동, `zt/zb/zz` 최신 응답 탐색 |
| 트리 | **45칸 고정**, 분류별 정렬·생성순, `r` 수동 이름/분류, working/unread/권한 대기 |
| footer | Vim 상태 + thinking + Codex weekly usage |
| 응답 | Korean Direct, URL/경로 강조, 사용자 메시지 정렬, Markdown heading 표시 보정 |
| 활동 | 경량 activity line, tool 및 경과 시간 표시 |
| Ponytail | `v4.9.0`, full 기본, 시작 알림·상태 표시 숨김 |
| IME | 자동 전환 비활성화. 원격 focus 간섭 방지 |
| 기타 패키지 | image generation, schedule prompt, MCP adapter (정확한 목록은 settings.json) |

개별 동작과 키는 [pi/packages](pi/packages)의 각 README가 기준이다. `Ctrl+C`는 프롬프트를 지우지 않고 Esc처럼 처리한다. tree `n/a/r/x`, `j/k`, `Enter/l`, 마우스 선택을 지원한다. 현재 owner Pi 종료는 `:q`로 한다.

> 전역 설정에는 기존 `defaultProjectTrust: "always"`가 포함된다. 신뢰하지 않는 repo의 프로젝트 확장 실행이 위험하므로 다른 사용자는 이 정책을 검토하고 자신의 Pi trust 설정으로 변경해야 한다.

## 3. MCP / Sky 복원

[config/mcp.example.json](config/mcp.example.json)은 **템플릿**이다. 기존 `~/.config/mcp/mcp.json`을 덮어쓰지 말고 필요한 서버만 병합한다. `@HOME@`는 실제 홈 경로로 바꾸고 Slack client ID를 구성한다. 인증 데이터는 OS Keychain/로컬 인증 파일에만 둔다.

Sky prerequisites:
1. ChatGPT/Codex 앱 로그인, 앱이 설치한 CUAService와 SkyComputerUseClient 경로 확인.
2. macOS Accessibility/Screen Recording 권한을 사용자가 승인.
3. 예시의 Codex sandbox/IPC socket 경로가 현재 앱 버전과 맞는지 확인. 앱 버전에 따라 바뀌므로 경로를 만들어 속이지 않는다.
4. Node REPL을 쓰려면 wrapper 설치:

```bash
mkdir -p ~/.local/bin
install -m 700 scripts/vipi-node-repl-computer-use ~/.local/bin/vipi-node-repl-computer-use
```

`sky-node-repl.env`에 있는 앱 build/version, browser-service 경로는 **예시 설치 시점 값**이다. 현재 로컬 앱의 실제 파일로 갱신한다. 이 repo는 앱 번들·모델·로그인·OS 권한을 설치하지 않는다. sandbox 예시는 기존 `:danger-full-access` 구성을 보존하므로 신뢰한 코드만 사용한다.

같은 Mac의 Sky client들은 화면·마우스·키보드 focus를 공유한다. 브라우저 프로필 분리만으로 동시 desktop 조작을 안전하게 만들 수 없다. Mac별 endpoint 분리 또는 foreground 작업 직렬화가 필요하다. Playwright로 자동 교체하지 않는다.

Slack OAuth에서 `User interaction is not allowed`가 나면 로컬 로그인 GUI 터미널에서 Keychain을 확인/해제한 뒤 `/mcp-auth slack`을 다시 시도한다. 평문 token으로 우회하지 않는다.

회사 전용 CRM/Amplitude 등 연결은 공개 repo에 넣지 않았다. 각 사용자가 승인된 endpoint·OAuth 설정을 로컬 MCP 파일에 추가한다. 서버 조회와 실제 도구 호출은 따로 검증한다.

### 권한 대기 패치

`pi-mcp-adapter@2.27.0` 원본 대비 [patch](patches/pi-mcp-adapter-2.27.0.patch)를 저장했다. 실제 approval/elicitation lifecycle에서 pane option `@pi_permission_waiting=mcp:<PID>`를 켜고 finally/lifecycle에서 해제한다. 화면 문자열을 검색해서 권한 상태를 추측하지 않는다.

패치 스크립트는 버전 불일치를 거부하고 이미 적용된 패치에는 아무것도 하지 않는다. npm 재설치 후 다시 실행한다. adapter 업데이트 시 새 원본과 diff를 재검토해야 한다. `pi update --all`을 무조건 실행하지 않는다.

## 4. iOS / 원격 사용

[vipi-ios/README.md](vipi-ios/README.md)를 **전체** 읽고 그 문서의 host 설정, launchd, Tailscale HTTPS, device pairing, APNs, Xcode build 순서를 따른다. 모바일 환경의 단일 기준 문서는 서브모듈 README다.

- 터미널 접속: Tailscale + SSH + tmux + Pi regular TUI.
- Vipi iOS: private 서브모듈의 host/extension/client.
- Paseo를 별도로 사용하는 경우 기존 터미널 프로세스에 직접 attach하는 것과 RPC 세션 handoff를 혼동하지 않는다. Paseo 자체 설치/인증 데이터는 이 repo에 없다.
- APNs `.p8`, pairing token, 기기 registry는 `~/.pi/agent/vipi/` 등에만 저장한다.
- 사진/영상 보고는 dedicated HTTP 디렉터리 + 머신의 Tailscale 주소 + 검증된 직접 URL. 홈/프로젝트 전체를 serve하지 않는다.

## 5. 유지보수와 롤백

```bash
git pull --ff-only
git submodule update --init --recursive
python3 scripts/check.py
python3 scripts/setup.py                  # 변경 대상 확인
# 템플릿 변경을 적용할 때:
python3 scripts/setup.py --apply
sh scripts/patch-mcp.sh
```

템플릿 재적용 시 기존 iOS 경로를 유지하려면 다시 `--ios-path`를 지정한다. linked extension 수정은 파일에 즉시 반영되지만 실행 중 Pi에는 `/reload`가 필요하다. repo를 이동하면 symlink가 깨지므로 새 위치에서 setup을 다시 실행한다.

롤백: 해당 timestamp 백업의 파일/폴더를 원래 경로로 복원한다. symlink는 링크 자체만 제거하고 원본 repo를 삭제하지 않는다. MCP 패치 롤백은 adapter 디렉터리에서 `git apply --reverse <repo>/patches/pi-mcp-adapter-2.27.0.patch`. iOS 서브모듈 버전 변경은 해당 repo에서 테스트·커밋·push한 후 부모 repo에서 포인터를 커밋한다.

## 6. 포함하지 않는 것 / 검증 범위

인증·세션 JSONL·workspace/catalog registry·weekly usage·MCP 캐시·첨부·생성 미디어·브라우저 프로필·node_modules·앱 번들·launchd의 개인 설정은 제외한다. 기존 원본은 지우지 않는다. 이 저장소만으로 로그인된 상태까지 복원할 수 없다.

`python3 scripts/check.py`는 JSON, manifest, shell 문법, 기본값, 개인 절대경로 유출을 검사하는 offline check다. macOS 권한 승인, GitHub private 접근, 실제 MCP/model 호출, tmux/마우스 UI 전체 회귀 검사를 대신하지 않는다.

커스텀 포크의 원래 LICENSE와 README는 각 package에 유지한다. 서드파티 npm/git 소스는 settings에 명시된 버전으로 설치한다.
