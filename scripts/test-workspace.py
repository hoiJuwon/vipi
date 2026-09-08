#!/usr/bin/env python3
"""Offline tests, including tmux-server loss/recovery on a disposable socket."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import uuid

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='vipi-workspace-test-') as directory:
    home = Path(directory)
    os.environ['VIPI_STATE_DIR'] = str(home / 'state')
    os.environ['VIPI_TMUX_SOCKET'] = 'vipi-test-' + uuid.uuid4().hex[:12]
    loader = importlib.machinery.SourceFileLoader('workspace', str(root / 'scripts/vipi'))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    m = importlib.util.module_from_spec(spec)
    loader.exec_module(m)
    m.HOME = home
    m.AGENT = home / '.pi/agent'
    (home / 'bin').mkdir()
    fake = home / 'bin/pi'
    fake.write_text('#!/bin/sh\nexec sleep 86400\n')
    fake.chmod(0o700)
    os.environ['PATH'] = str(home / 'bin') + ':' + os.environ['PATH']
    records = []
    for i in range(2):
        file = home / f'conversation {i}.jsonl'
        identity = str(uuid.uuid4())
        m.atomic_json(file, {'type': 'session', 'version': 3, 'id': identity, 'cwd': str(home)}, compact=True)
        records.append({'id': identity, 'file': str(file), 'cwd': str(home), 'name': f'Pi {i}', 'tree': False})
    m.atomic_json(m.AGENT / 'settings.json', {'packages': ['npm:pi-schedule-prompt@0.4.1']})
    assert 'pi-schedule-prompt' not in m.command_for(records[0])
    assert '--session' in m.command_for(records[0])
    assert m.header(records[0]['file'])['id'] == records[0]['id']
    assert not m.header(str(home / 'missing'))
    data = {'version': 1, 'session': 'test', 'selected': records[1]['id'], 'sessions': records}
    m.atomic_json(m.MANIFEST, data)
    try:
        # Override real user's tmux.conf for this isolated server only.
        subprocess.run(['tmux', '-L', m.SOCKET, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', 'sleep 86400'], check=True)
        m.start(no_tree=True)
        first = [p for p in m.panes() if p['session_name'] == 'test']
        assert len(first) == 2
        assert any(p['@vipi_restore_id'] == records[1]['id'] and p['window_active'] == '1' for p in first)
        m.start(no_tree=True)
        assert len([p for p in m.panes() if p['session_name'] == 'test']) == 2
        saved = m.checkpoint()
        assert len(saved['sessions']) == 2
        assert m.MANIFEST.stat().st_mode & 0o777 == 0o600
        m.tmux('kill-server')  # Never touches the real/default tmux server.
        assert m.checkpoint() == saved, 'server loss must not erase snapshot'
        subprocess.run(['tmux', '-L', m.SOCKET, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', 'sleep 86400'], check=True)
        m.start(no_tree=True)
        assert len([p for p in m.panes() if p['session_name'] == 'test']) == 2
        assert {p['@vipi_restore_id'] for p in m.panes() if p['session_name'] == 'test'} == {r['id'] for r in records}
        # Missing source must survive partial recovery and future checkpoints.
        m.tmux('kill-session', '-t', 'test')
        Path(records[1]['file']).unlink()
        m.start(no_tree=True)
        assert len(m.read_json(m.MANIFEST, {})['pending']) == 1
        m.checkpoint()
        assert len(m.read_json(m.MANIFEST, {})['sessions']) == 2
        print('PASS: quoting, scheduler excluded, 0600, attach idempotence, selected window, server-loss restore, partial recovery')
    finally:
        m.tmux('kill-server', check=False)
