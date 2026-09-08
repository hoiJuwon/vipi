#!/usr/bin/env python3
"""Actual Pi + tree startup test. Isolated HOME/socket, offline, no prompt/model call."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='vipi-tui-test-') as directory:
    home = Path(directory)
    os.environ.update(HOME=directory, VIPI_STATE_DIR=str(home / 'state'),
                      VIPI_TMUX_SOCKET='vipi-tui-' + uuid.uuid4().hex[:12], PI_OFFLINE='1')
    loader = importlib.machinery.SourceFileLoader('workspace', str(root / 'scripts/vipi'))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    m = importlib.util.module_from_spec(spec)
    loader.exec_module(m)
    m.atomic_json(m.AGENT / 'settings.json', {'packages': [str(p) for p in (root / 'pi/packages').iterdir()],
                  'defaultProvider': 'openai-codex', 'defaultModel': 'gpt-6-astra', 'defaultThinkingLevel': 'medium'})
    file = home / 'fixture.jsonl'
    identity = str(uuid.uuid4())
    m.atomic_json(file, {'type': 'session', 'version': 3, 'id': identity,
                        'timestamp': '2026-01-01T00:00:00Z', 'cwd': str(home)}, compact=True)
    m.atomic_json(m.MANIFEST, {'version': 1, 'session': 'test', 'selected': identity,
                  'sessions': [{'id': identity, 'file': str(file), 'cwd': str(home),
                                'name': '개발 / restore fixture', 'tree': True, 'root': str(home)}]})
    try:
        subprocess.run(['tmux', '-L', m.SOCKET, '-f', '/dev/null', 'new-session', '-d', '-s', 'fixture', 'sleep 86400'], check=True)
        m.start()
        end = time.time() + 30
        ready = False
        while time.time() < end:
            live = [p for p in m.panes() if p['session_name'] == 'test']
            pi_pane = next(p for p in live if p['@vipi_restore_id'] == identity)
            tree = next(p for p in live if p['@pi_session_tree'] == '1')
            screen = m.tmux('capture-pane', '-p', '-t', pi_pane['pane_id']).stdout
            registered = any(e.get('piSessionId') == identity for e in m.registry())
            tree_ready = m.tmux('show-options', '-p', '-v', '-t', tree['pane_id'], '@pi_session_tree_ready', check=False).stdout.strip()
            if 'NORMAL' in screen and registered and tree_ready == '1':
                ready = True
                break
            time.sleep(0.5)
        assert ready, screen
        width = m.tmux('display-message', '-p', '-t', tree['pane_id'], '#{pane_width}').stdout.strip()
        assert width == '45', width
        m.checkpoint()
        assert len(m.read_json(m.MANIFEST, {})['sessions']) == 1
        print('PASS: actual Pi resume, NORMAL, registry registration, ready tree, 45 columns, checkpoint (no model call)')
    finally:
        m.tmux('kill-server', check=False)
