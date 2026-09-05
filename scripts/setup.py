#!/usr/bin/env python3
"""Install reviewed config, preserving machine-local secrets and rollback copies."""
import argparse
import datetime
import json
import os
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--apply', action='store_true', help='Without this flag, only print planned destinations')
parser.add_argument('--ios-path', type=Path, default=ROOT / 'vipi-ios')
args = parser.parse_args()
home = Path.home()
agent = home / '.pi/agent'
local_path = ROOT / 'machine.local.json'
local = json.loads(local_path.read_text()) if local_path.exists() else {}
backup = home / '.local/state/vipi/backups' / datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
variables = {'HOME': str(home), 'TAILSCALE_IP': local.get('tailscaleIp', '<configure-tailscale-ip>'),
             'REMOTE_MAC': local.get('remoteMac', '<configure-ssh-alias>'),
             'REMOTE_HOSTNAME': local.get('remoteHostname', '<configure-remote-hostname>')}

def render(text):
    for key, value in variables.items():
        text = text.replace('@' + key + '@', value)
    return text

def install(dest, text=None, source=None):
    print(('APPLY ' if args.apply else 'PLAN  ') + str(dest))
    if not args.apply:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() or dest.is_symlink():
        if source and dest.is_symlink() and dest.resolve() == source.resolve():
            return
        saved = backup / dest.relative_to(home)
        saved.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(dest), str(saved))
    if source:
        dest.symlink_to(source, target_is_directory=source.is_dir())
    else:
        dest.write_text(text)

for folder in ['packages', 'themes', 'response-styles']:
    for source in (ROOT / 'pi' / folder).iterdir():
        install(agent / folder / source.name, source=source)
settings_path = agent / 'settings.json'
settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
defaults = json.loads((ROOT / 'pi/settings.json').read_text())
packages = [p.replace('@VIPI_IOS@', str(args.ios_path.resolve())) for p in defaults.pop('packages')]
# Preserve unrelated package sources; replace only the known iOS source.
extras = [p for p in settings.get('packages', []) if p not in packages
          and not (isinstance(p, str) and p.endswith('/vipi-ios'))]
settings.update(defaults)
settings['packages'] = packages + extras
install(settings_path, text=json.dumps(settings, indent=2) + '\n')
install(agent / 'AGENTS.md', text=render((ROOT / 'pi/AGENTS.md').read_text()))
install(home / '.tmux.conf', text=render((ROOT / 'config/tmux.conf').read_text()))
install(home / '.config/ponytail/config.json', text=(ROOT / 'config/ponytail.json').read_text())
print('MCP/auth/session state untouched. Backups:', backup)
