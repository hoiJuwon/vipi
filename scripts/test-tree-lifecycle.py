#!/usr/bin/env python3
"""Real Neovim + disposable tmux: redraw, async polling, prompts and worker exit.
Never uses the user's default socket, registry or Pi sessions. No model calls.
"""
import json
import os
import pty
import fcntl
import struct
import termios
from pathlib import Path
import shlex
import shutil
import signal
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
TMUX = shutil.which('tmux')
NVIM = shutil.which('nvim')
SOCKET = 'vipi-tree-test-' + uuid.uuid4().hex[:10]

def tmux(*args, check=True):
    return subprocess.run([TMUX, '-L', SOCKET, *map(str, args)], capture_output=True, text=True, check=check, timeout=8).stdout.strip()

def wait(predicate, timeout=8):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return
        time.sleep(0.1)
    raise AssertionError('condition timed out')

def alive(pid):
    return subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True).stdout.strip() not in ('', 'Z', 'Zs')

with tempfile.TemporaryDirectory(prefix='vipi-tree-lifecycle-') as directory:
    home = Path(directory)
    bin_dir = home / 'bin'
    bin_dir.mkdir()
    calls = home / 'calls'
    slow = home / 'slow'
    wrapper = bin_dir / 'tmux'
    wrapper.write_text('#!' + shutil.which('python3') + '\nimport os,sys,time\n'
                       f'with open({str(calls)!r},"a") as f:f.write(str(time.monotonic())+" "+" ".join(sys.argv[1:])+"\\n")\n'
                       f'if os.path.exists({str(slow)!r}) and sys.argv[1:2]==["list-panes"]:time.sleep(2)\n'
                       f'os.execv({TMUX!r},[{TMUX!r}]+sys.argv[1:])\n')
    wrapper.chmod(0o700)
    registry = home / 'registry.json'
    catalog = home / 'catalog.json'
    workspaces = home / 'workspaces.json'
    catalog.write_text('{"entries":[]}')
    workspaces.write_text(json.dumps({'workspaces': [str(home)]}))
    workers = []
    client = None
    mouse_clients = []
    try:
        tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', '-x', '140', '-y', '40', 'sleep 3600')
        owner = tmux('display-message', '-p', '-t', 'fixture', '#{pane_id}')
        owner_pid = int(tmux('display-message', '-p', '-t', owner, '#{pane_pid}'))
        data = {'entries': [{'piSessionId': 'fixture', 'name': '개발 / 검증', 'cwd': str(home),
                            'tmuxPaneId': owner, 'pid': owner_pid, 'tmuxSession': 'fixture', 'tmuxWindow': '0',
                            'status': 'idle', 'unread': False}]}
        registry.write_text(json.dumps(data))  # live row with no sessionFile must still show
        client = subprocess.Popen([TMUX, '-L', SOCKET, '-C', 'attach-session', '-t', 'fixture'],
                                  stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait(lambda: tmux('display-message', '-p', '-t', owner, '#{session_attached}') == '1')

        def launch(target_owner=owner):
            server = home / ('rpc-' + uuid.uuid4().hex[:8])
            command = shlex.join([NVIM, '--listen', str(server), '--clean', '-n', '-u', str(ROOT / 'pi/packages/pi-session-tree/tree.lua')])
            args = ['split-window', '-d', '-b', '-h', '-l', '45', '-t', target_owner, '-P', '-F', '#{pane_id}']
            env = {'PATH': str(bin_dir) + ':' + os.environ['PATH'], 'PI_SESSION_TREE_ROOT': str(home),
                   'PI_SESSION_TREE_REGISTRY': str(registry), 'PI_SESSION_TREE_CATALOG': str(catalog),
                   'PI_SESSION_TREE_WORKSPACES': str(workspaces)}
            for k, v in env.items():
                args += ['-e', k + '=' + v]
            pane = tmux(*args, 'exec env ' + shlex.quote('PATH=' + env['PATH']) + ' ' + command)
            tmux('set-option', '-p', '-t', pane, '@pi_session_tree', '1')
            tmux('set-option', '-p', '-t', pane, '@pi_session_tree_owner', target_owner)
            def lua(code):
                expr = 'luaeval(' + json.dumps(code) + ')'
                return subprocess.check_output([NVIM, '--server', str(server), '--remote-expr', expr], text=True, timeout=5).strip()
            wait(lambda: server.exists())
            wait(lambda: tmux('show-options', '-p', '-v', '-t', pane, '@pi_session_tree_ready', check=False) == '1')
            pid = int(lua('vim.fn.getpid()'))
            parent = int(tmux('display-message', '-p', '-t', pane, '#{pane_pid}'))
            workers.append(pid)
            return pane, pid, parent, lua

        pane, pid, parent, lua = launch()
        assert '검증' in lua('table.concat(vim.api.nvim_buf_get_lines(0,0,-1,false),"\\n")')
        before = registry.read_bytes()
        time.sleep(0.5)
        tick = lua('vim.api.nvim_buf_get_changedtick(0)')
        start_calls = len(calls.read_text().splitlines())
        time.sleep(2)
        assert lua('vim.api.nvim_buf_get_changedtick(0)') == tick, 'idle polling rewrote buffer'
        visible_calls = len(calls.read_text().splitlines()) - start_calls
        assert visible_calls <= 9, visible_calls
        assert registry.read_bytes() == before, 'polling must not overwrite shared registry'
        tmux('set-option', '-p', '-t', owner, '@pi_permission_waiting', 'mcp:' + str(os.getpid()))
        wait(lambda: '●' in lua('table.concat(vim.api.nvim_buf_get_lines(0,0,-1,false),"\\n")'))
        tmux('set-option', '-p', '-t', owner, '@pi_permission_waiting', 'mcp:999999999')
        wait(lambda: '○' in lua('table.concat(vim.api.nvim_buf_get_lines(0,0,-1,false),"\\n")'))
        tmux('select-pane', '-t', pane)
        tmux('send-keys', '-t', pane, 'r')
        time.sleep(0.4)
        tick = lua('vim.api.nvim_buf_get_changedtick(0)')
        time.sleep(1)
        assert lua('vim.api.nvim_buf_get_changedtick(0)') == tick, 'timer interfered with rename prompt'
        tmux('send-keys', '-t', pane, 'Escape')
        time.sleep(0.3)

        # A hidden target window usually remembers its tree pane as active after
        # the prior visit. Activating the target Pi must happen before switching
        # windows, or tmux visibly paints tree -> Pi on every session click.
        target_owner = tmux('new-window', '-d', '-t', 'fixture:', '-P', '-F', '#{pane_id}', 'sleep 3600')
        target_window = tmux('display-message', '-p', '-t', target_owner, '#{window_index}')
        target_pid = int(tmux('display-message', '-p', '-t', target_owner, '#{pane_pid}'))
        data['entries'].append({'piSessionId': 'target', 'name': '개발 / 대상', 'cwd': str(home),
                                'tmuxPaneId': target_owner, 'pid': target_pid, 'tmuxSession': 'fixture',
                                'tmuxWindow': target_window, 'status': 'idle', 'unread': False})
        registry.write_text(json.dumps(data))
        target_tree, target_worker, _target_parent, _target_lua = launch(target_owner)
        tmux('select-pane', '-t', target_tree)  # reproduce remembered hidden tree focus
        tmux('select-window', '-t', owner)
        tmux('select-pane', '-t', pane)
        wait(lambda: '대상' in lua('table.concat(vim.api.nvim_buf_get_lines(0,0,-1,false),"\\n")'))
        target_line = int(lua('(function() for i,line in ipairs(vim.api.nvim_buf_get_lines(0,0,-1,false)) do if line:find("대상",1,true) then return i end end return 0 end)()'))
        calls.write_text('')
        lua(f'vim.api.nvim_win_set_cursor(0,{{{target_line},0}})')
        tmux('send-keys', '-t', pane, 'Enter')
        wait(lambda: any('switch-client' in line for line in calls.read_text().splitlines()))
        assert tmux('display-message', '-p', '-t', target_owner, '#{pane_active}') == '1'
        transition_calls = calls.read_text().splitlines()
        select_at = next(i for i, line in enumerate(transition_calls) if f'select-pane -t {target_owner}' in line)
        switch_at = next(i for i, line in enumerate(transition_calls) if 'switch-client' in line)
        assert select_at < switch_at, transition_calls
        tmux('select-window', '-t', owner)
        tmux('select-pane', '-t', pane)
        # tmux's display-message -t pane picks an arbitrary attached client.
        # Real mouse input must carry the originating tty through the binding.
        mouse_binding = home / 'mouse.conf'
        mouse_binding.write_text(next(line for line in (ROOT / 'config/tmux.conf').read_text().splitlines()
                                      if line.startswith('bind-key -T root MouseDown1Pane ')) + '\n')
        tmux('source-file', mouse_binding)
        tmux('set-option', '-g', 'mouse', 'on')
        for _ in range(2):
            master, slave = pty.openpty()
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 140, 0, 0))
            process = subprocess.Popen([TMUX, '-L', SOCKET, 'attach-session', '-t', 'fixture'],
                                       stdin=slave, stdout=slave, stderr=slave,
                                       env={**os.environ, 'TERM': 'xterm-256color'}, start_new_session=True)
            mouse_clients.append((process, master, slave, os.ttyname(slave)))
            time.sleep(0.2)
        wait(lambda: all(tty in tmux('list-clients', '-F', '#{client_tty}').splitlines()
                         for _, _, _, tty in mouse_clients))
        assert tmux('display-message', '-p', '-t', pane, '#{client_tty}') != mouse_clients[0][3], 'fixture must reproduce wrong-client inference'
        calls.write_text('')
        os.write(mouse_clients[0][1], f'\x1b[<0;3;{target_line}M'.encode())
        wait(lambda: any('switch-client -c ' + mouse_clients[0][3] in line
                         for line in calls.read_text().splitlines()), timeout=5)
        assert tmux('show-options', '-p', '-v', '-t', pane, '@pi_session_tree_click_client') == mouse_clients[0][3]
        tmux('select-window', '-t', owner)
        tmux('select-pane', '-t', pane)
        for process, master, slave, _ in mouse_clients:
            process.terminate(); process.wait(timeout=5)
            os.close(master); os.close(slave)
        mouse_clients.clear()
        tmux('kill-pane', '-t', target_tree)
        wait(lambda: not alive(target_worker))
        data['entries'].pop()
        registry.write_text(json.dumps(data))

        # Slow tmux must not block Neovim input or queue periodic work recursively.
        slow.touch()
        time.sleep(0.4)
        start = time.monotonic()
        lua('vim.api.nvim_win_get_cursor(0)[1]')
        assert time.monotonic() - start < 0.7, 'sync poll blocked RPC/input'
        slow.unlink()
        hidden = tmux('new-window', '-t', 'fixture:', '-P', '-F', '#{window_id}', 'sleep 3600')
        time.sleep(1)
        tick = lua('vim.api.nvim_buf_get_changedtick(0)')
        start_calls = len(calls.read_text().splitlines())
        time.sleep(3)
        hidden_calls = len(calls.read_text().splitlines()) - start_calls
        assert hidden_calls <= 2, hidden_calls
        assert lua('vim.api.nvim_buf_get_changedtick(0)') == tick
        tmux('select-window', '-t', owner)
        time.sleep(2.2)
        tmux('select-pane', '-t', pane)
        tmux('send-keys', '-t', pane, 'q')
        wait(lambda: not alive(pid))
        # Kill-pane, TUI-parent SIGKILL, and entire test-server loss must not leak embed workers.
        for scenario in ['kill-pane', 'error-kill', 'parent-kill', 'kill-server']:
            pane, pid, parent, lua = launch()
            if scenario == 'error-kill':
                lua('(function() vim.api.nvim_buf_set_lines=function() error("injected-render-failure") end; return 1 end)()')
                data['entries'][0]['status'] = 'working'
                registry.write_text(json.dumps(data))
                wait(lambda: 'injected-render-failure' in lua('vim.g.pi_tree_last_error or ""'))
                assert 'Press ENTER' not in tmux('capture-pane', '-p', '-t', pane)
                tmux('kill-pane', '-t', pane)
                data['entries'][0]['status'] = 'idle'
                registry.write_text(json.dumps(data))
            elif scenario == 'kill-pane':
                tmux('kill-pane', '-t', pane)
            elif scenario == 'parent-kill':
                assert parent != pid, 'expected separate Neovim terminal UI parent'
                os.kill(parent, signal.SIGKILL)
            else:
                tmux('kill-server')
            wait(lambda: not alive(pid))
        print(f'PASS: idle redraw=0, read-only registry, new unsaved row, permission PID, rename/input safety, '
              f'target Pi selected before exposure, mouse origin preserved across clients, visible tmux calls={visible_calls}/2s, hidden={hidden_calls}/3s; q/kill-pane/render-error+kill/SIGKILL/server loss leave no workers')
    finally:
        tmux('kill-server', check=False)
        if client:
            client.terminate()
            client.wait(timeout=5)
        for process, master, slave, _ in mouse_clients:
            process.terminate(); process.wait(timeout=5)
            os.close(master); os.close(slave)
        for pid in workers:
            if alive(pid):
                os.kill(pid, signal.SIGKILL)
