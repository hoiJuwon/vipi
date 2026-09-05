#!/usr/bin/env python3
"""Offline repository invariants; no network or model calls."""
import json
import re
from pathlib import Path
import subprocess
root = Path(__file__).resolve().parents[1]
settings = json.loads((root / 'pi/settings.json').read_text())
assert settings['defaultModel'] == 'gpt-6-astra'
assert settings['defaultThinkingLevel'] == 'medium'
assert settings['tuiMode'] == 'regular'
assert 'modeChange' not in settings['piVim']
for p in settings['packages']:
    if p.startswith('packages/'):
        manifest = json.loads((root / 'pi' / p / 'package.json').read_text())
        for entry in manifest['pi']['extensions']:
            assert (root / 'pi' / p / entry).exists()
for p in list((root / 'config').glob('*.json')) + list((root / 'pi/themes').glob('*.json')):
    json.loads(p.read_text())
for p in (root / 'pi/packages').rglob('*.sh'):
    subprocess.run(['sh', '-n', str(p)], check=True)
assert '45' in (root / 'pi/packages/pi-session-tree/fix-sidebar-width.sh').read_text()
assert '@HOME@' in (root / 'config/tmux.conf').read_text()
assert (root / 'patches/pi-mcp-adapter-2.27.0.patch').stat().st_size > 0
for folder in ['pi', 'config', 'scripts', 'patches']:
    for p in (root / folder).rglob('*'):
        if p.is_file() and '__pycache__' not in p.parts:
            text = p.read_text()
            assert not re.search(r'/Users/(?!Shared\b)[A-Za-z0-9_-]+/', text), f'Personal absolute path: {p}'
print('PASS: settings, manifests, shell syntax, JSON, portable paths, patch presence')
