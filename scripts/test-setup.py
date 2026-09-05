#!/usr/bin/env python3
"""Regression check: install twice into a disposable HOME; leave real config alone."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='vipi-setup-test-') as directory:
    home = Path(directory)
    env = dict(os.environ, HOME=directory)
    for _ in range(2):
        subprocess.run(['python3', str(root / 'scripts/setup.py'), '--apply'],
                       env=env, check=True, stdout=subprocess.DEVNULL)
    settings = json.loads((home / '.pi/agent/settings.json').read_text())
    assert settings['defaultModel'] == 'gpt-6-astra'
    assert len(settings['packages']) == len(set(settings['packages']))
    assert (home / '.pi/agent/packages/pi-vim-local').is_symlink()
    assert str(home) in (home / '.tmux.conf').read_text()
    assert not (home / '.config/mcp/mcp.json').exists()
    assert list((home / '.local/state/vipi/backups').glob('*/.tmux.conf'))
print('PASS: isolated install, idempotent package list, backup, rendering, MCP untouched')
