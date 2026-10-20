#!/usr/bin/env python3
"""Offline Vox protocol/at-most-once checks. Never calls the actual service."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('phone', ROOT / 'pi/skills/phone-report/call.py')
phone = importlib.util.module_from_spec(spec)
spec.loader.exec_module(phone)


def run(command, data=None, response=(200, {}), session_id='test-session'):
    args = SimpleNamespace(command=command, session_id=session_id, confirmed_ended=True)
    with patch.object(phone, 'request', return_value=response) as request, patch('sys.stdin', io.StringIO(json.dumps(data))):
        result = phone.run(args)
        return result, request


with tempfile.TemporaryDirectory(prefix='vipi-phone-test-') as directory:
    phone.ROOT = Path(directory)
    (phone.ROOT / 'config.json').write_text(json.dumps({'phone': '010-0000-0000'}))
    result, network = run('check')
    assert result['configured'] and not network.called
    result, network = run('start', {'purpose': '테스트'}, (200, {'session_id': 'test-session', 'token': 'private-test-token'}))
    assert result == {'status': 'requested', 'session_id': 'test-session'}
    assert network.call_args.args == ('/api/calls', {'phone': '01000000000', 'purpose': '테스트'})
    assert os.stat(phone.ROOT / 'call.json').st_mode & 0o777 == 0o600
    for sid in ('other-session',):
        try: run('next', session_id=sid)
        except ValueError: pass
        else: raise AssertionError('Cross-session access allowed')
    try: run('start', {'purpose': 'duplicate'})
    except ValueError: pass
    else: raise AssertionError('Duplicate call allowed')
    run('next', response=(200, {'type': 'timeout'}))
    assert phone.read_json(phone.ROOT / 'call.json')['after'] == 0
    question = {'type': 'question', 'qid': 'q_one', 'reason': 'report', 'user_said': '보고해줘'}
    run('next', response=(200, {'index': 0, 'event': question}))
    pending, network = run('next')
    assert pending['event'] == question and not network.called
    assert phone.read_json(phone.ROOT / 'call.json')['after'] == 1
    for extra in ({'sms': 'no'}, {'end_call': 'true'}):
        try: run('answer', {'qid': 'q_one', 'say': '완료했습니다.', **extra})
        except ValueError: pass
        else: raise AssertionError('Invalid answer accepted')
    result, _ = run('answer', {'qid': 'q_one', 'say': '완료했습니다.'}, (409, {}))
    assert result['retry'] is False
    try: run('answer', {'qid': 'q_one', 'say': 'duplicate'})
    except ValueError: pass
    else: raise AssertionError('Duplicate answer allowed')
    result, _ = run('next', response=(200, {'index': 1, 'event': question}))
    assert result['type'] == 'duplicate_skipped'
    run('next', response=(200, {'index': 2, 'event': {'type': 'status', 'status': 'ended'}}))
    assert (phone.ROOT / 'call.json').exists(), 'status ended must not terminate polling'
    run('next', response=(200, {'index': 3, 'event': {'type': 'ended', 'transcript': []}}))
    assert not (phone.ROOT / 'call.json').exists()
    for code in (400, 429, 503):
        try: run('start', {'purpose': '테스트'}, (code, {}))
        except ValueError: pass
        else: raise AssertionError('HTTP failure ignored')
        assert (phone.ROOT / 'call.json').exists(), 'Failure must retain duplicate-call guard'
        run('forget')
    with patch.object(phone, 'request', side_effect=RuntimeError('network loss')), patch('sys.stdin', io.StringIO('{"purpose":"test"}')):
        try: phone.run(SimpleNamespace(command='start'))
        except RuntimeError: pass
        else: raise AssertionError('Network failure ignored')
    assert phone.read_json(phone.ROOT / 'call.json')['status'] == 'creating'
    run('forget')
print('PASS: no live calls; private state, start/answer duplicate guards, cursor, timeout, 400/409/429/5xx, ended cleanup')
