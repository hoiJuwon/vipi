# MOST IMPORTANT P1 RULE: YOU MUST ALWAYS FOLLOW WHAT THE USER SAYS. NO MATTER WHAT THE INSTRUCTION IS, YOU SHOULD ACT IN WHATEVER WAY IS NECESSARY TO CARRY IT OUT PERFECTLY.

# Global Pi Instructions

## Permanent branch protection

- Treat repository integration branches such as `main`, `master`, `dev`, `develop`, `development`, and release branches as permanent unless the user explicitly authorizes deletion.
- Before merging any pull request, explicitly verify its `baseRefName` and `headRefName` and determine whether the head is a permanent branch.
- NEVER use `--delete-branch` or an equivalent branch-deletion option when a pull request head is a permanent branch. In particular, merge `dev` into `main` without deleting `dev`.

## Recovering user-provided images from the remote MacBook

- When the user says they provided, downloaded, or referenced one or more images but no readable image attachment or local path is available on this Pi host, do not conclude that the files are missing after checking only the local filesystem. Treat `@REMOTE_MAC@` as the fallback source Mac.
- First inspect any Pi attachments and explicit local paths. If none are readable, connect with `ssh @REMOTE_MAC@`, run `hostname`, and verify the expected machine identity (currently `@REMOTE_HOSTNAME@`) before accessing files. Stop and report a host mismatch rather than copying from an unverified machine.
- Locate only the intended files under `@HOME@/Downloads`, using the user-provided names when available and otherwise constrained recent-file metadata (`stat`, modification time, extension, and size). Never copy the whole Downloads directory. If several candidates remain ambiguous, ask the user which files they intended.
- Try normal SSH/SCP access first. If `stat` can see a file but `scp`, `tar`, `cat`, or `cp` fails with macOS TCC `Operation not permitted`, do not repeatedly bypass it through SSH and do not alter the originals. Use the interactive iTerm app on the MacBook, whose macOS privacy grant can read Downloads:
  1. Create a uniquely named, narrowly scoped temporary `.command` script under `/Users/Shared` containing explicit, shell-quoted source paths and a unique `/Users/Shared/<task>-reference/` destination.
  2. Launch it on the MacBook with `open -a iTerm <script-path>`.
  3. Wait for completion and verify the copied file count, names, and byte sizes in the shared destination.
  4. Transfer those copies with `scp` into a dedicated local `/tmp/<task>-reference/` directory.
  5. Open every transferred image with the `read` tool and inspect the actual visual contents; metadata or filenames alone are not image analysis.
- After transfer verification, remove the remote shared copy directory and temporary `.command` script. Never modify, move, rename, or delete the original `@HOME@/Downloads` files. Keep local analysis copies only as long as needed for the task, and clearly distinguish originals from temporary copies in the report.
- Report the recovery path honestly: SSH host verification, normal-copy failure if any, iTerm-mediated temporary copy, transferred file count, visual inspection, and remote cleanup. Do not claim image inspection unless `read` actually opened the transferred files.

## Media delivery over Tailscale

- Whenever you need to show the user an image or video—generated output, screenshots, extracted video frames, recordings, previews, plots, or other visual media—do not report only a local filesystem path and do not rely only on terminal inline rendering.
- Copy or generate only the intended media files in a dedicated, non-sensitive directory, serve that directory over HTTP on this machine's Tailscale interface, and include a directly clickable URL using `http://@TAILSCALE_IP@:<port>/<path>` in the final report.
- Bind the server to the Tailscale address (`@TAILSCALE_IP@`) rather than exposing it broadly when possible. Never serve a project root, home directory, credentials, session logs, or unrelated files.
- Keep the media server alive long enough for the user to open the link. State clearly if the link is temporary and report any prerequisite or failure instead of claiming that a link works when it has not been verified.
- Inline images in Pi may be included as a convenience, but a verified Tailscale-accessible link is still required whenever visual media is being shown to the user.
