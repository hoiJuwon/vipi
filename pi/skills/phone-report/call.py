#!/usr/bin/env python3
"""Vox foreground call bridge. No automatic POST retries; credentials stay local."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener

ROOT = Path.home() / '.pi/agent/phone-report'
BASE = 'https://claude.tryvox.co'


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(path, body=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    req = Request(BASE + path, data=data, headers=headers)
    try:
        with build_opener(NoRedirect()).open(req, timeout=80) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except HTTPError as error:
        return error.code, {}  # Never echo remote HTML, phone numbers or credentials.
    except (URLError, TimeoutError, OSError, ValueError) as error:
        raise RuntimeError('응답 확인 실패. POST는 재전송하지 마세요. next만 재조회할 수 있습니다.') from error


def read_json(path):
    return json.loads(path.read_text())


def save(state):
    fd, path = tempfile.mkstemp(prefix='.call-', dir=ROOT)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(state, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(path, ROOT / 'call.json')
    finally:
        if os.path.exists(path):
            os.unlink(path)


def payload():
    value = json.load(sys.stdin)
    if not isinstance(value, dict):
        raise ValueError('JSON object required')
    return value


def phone():
    value = read_json(ROOT / 'config.json').get('phone')
    if not isinstance(value, str) or not re.fullmatch(r'0[0-9 -]{8,14}', value):
        raise ValueError('로컬 config.json의 국내 전화번호를 확인하세요.')
    digits = re.sub(r'[ -]', '', value)
    if not 9 <= len(digits) <= 11:
        raise ValueError('국내 전화번호 길이가 올바르지 않습니다.')
    return digits


def run(args):
    if args.command == 'check':
        phone()
        return {'configured': True, 'active_call': (ROOT / 'call.json').exists()}
    if args.command == 'forget':
        if not args.confirmed_ended:
            raise ValueError('실제 통화 종료 확인 후 --confirmed-ended가 필요합니다.')
        (ROOT / 'call.json').unlink(missing_ok=True)
        return {'local_state_removed': True, 'remote_hangup': False}
    if args.command == 'start':
        if (ROOT / 'call.json').exists():
            raise ValueError('기존 통화 또는 발신 여부가 불명확한 요청이 있습니다. 재발신하지 마세요.')
        data = payload()
        purpose = data.get('purpose')
        if set(data) != {'purpose'} or not isinstance(purpose, str) or len(purpose) >= 200:
            raise ValueError('purpose는 200자 미만 문자열이어야 합니다.')
        number = phone()
        save({'status': 'creating'})  # Persist BEFORE POST: ambiguous success must not redial.
        status, result = request('/api/calls', {'phone': number, 'purpose': purpose})
        if status in (400, 429):
            save({'status': 'rejected', 'http_status': status})
            raise ValueError(f'발신 거절 HTTP {status}. 자동 재시도하지 않습니다.')
        if status != 200 or not isinstance(result, dict) or not all(isinstance(result.get(k), str) and result[k] for k in ('session_id', 'token')):
            raise ValueError(f'발신 응답 확인 불가 HTTP {status}. 중복 발신하지 마세요.')
        save({'status': 'active', 'session_id': result['session_id'], 'token': result['token'], 'after': 0, 'answered': []})
        return {'status': 'requested', 'session_id': result['session_id']}
    state = read_json(ROOT / 'call.json')
    if state.get('session_id') != args.session_id or state.get('status') != 'active':
        raise ValueError('현재 통화 session_id와 일치하지 않습니다.')
    base = '/api/sessions/' + quote(args.session_id, safe='')
    if args.command == 'next':
        if state.get('pending'):
            return {'event': state['pending'], 'pending': True}
        status, result = request(base + '/next?after=' + str(state['after']), token=state['token'])
        if status != 200 or not isinstance(result, dict):
            raise ValueError(f'이벤트 조회 실패 HTTP {status}. 새 발신 없이 next를 재조회하세요.')
        if result.get('type') == 'timeout':
            return result
        index, event = result.get('index'), result.get('event')
        if type(index) is not int or index < state['after'] or not isinstance(event, dict):
            raise ValueError('이벤트 형식/인덱스가 올바르지 않습니다.')
        if event.get('type') == 'question' and not isinstance(event.get('qid'), str):
            raise ValueError('question qid가 없습니다.')
        state['after'] = index + 1
        if event.get('type') == 'question':
            if event['qid'] in state['answered']:
                save(state)
                return {'type': 'duplicate_skipped', 'after': state['after']}
            state['pending'] = event
        save(state)
        if event.get('type') == 'ended':
            (ROOT / 'call.json').unlink()  # Token/transcript are not retained after completion.
        return result
    data = payload()
    if set(data) - {'qid', 'say', 'instructions', 'end_call'}:
        raise ValueError('허용 필드: qid, say, instructions, end_call (SMS 미지원)')
    if not isinstance(data.get('say'), str) or not data['say'].strip():
        raise ValueError('say가 필요합니다.')
    if 'instructions' in data and not isinstance(data['instructions'], str):
        raise ValueError('instructions는 문자열이어야 합니다.')
    if 'end_call' in data and type(data['end_call']) is not bool:
        raise ValueError('end_call은 boolean이어야 합니다.')
    qid = data.get('qid')
    if not isinstance(qid, str) or qid != state.get('pending', {}).get('qid') or qid in state['answered']:
        raise ValueError('현재 미응답 질문의 qid가 아닙니다. 재전송하지 마세요.')
    state['answered'].append(qid)  # At-most-once even if the server accepted a lost response.
    state.pop('pending')
    save(state)
    status, _ = request(base + '/answer', data, state['token'])
    if status == 409:
        return {'status': 'expired_or_answered', 'retry': False}
    if status != 200:
        raise ValueError(f'답변 응답 HTTP {status}. 같은 qid는 재전송하지 말고 next로 진행하세요.')
    return {'status': 'answered', 'qid': qid}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for cmd in ('check', 'start'):
        sub.add_parser(cmd)
    for cmd in ('next', 'answer'):
        sub.add_parser(cmd).add_argument('session_id')
    sub.add_parser('forget').add_argument('--confirmed-ended', action='store_true')
    args = parser.parse_args()
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(ROOT / '.lock', os.O_CREAT | os.O_RDWR, 0o600)
    try:
        with os.fdopen(fd, 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print(json.dumps(run(args), ensure_ascii=False))
    except (ValueError, RuntimeError, OSError) as error:
        # No traceback or raw request/response which could reveal the bearer token.
        print(str(error), file=sys.stderr)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
