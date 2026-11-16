"""Connect the operator's event-owned VRChat account locally; never log credentials."""
import base64
import ctypes
import datetime
import getpass
import http.cookiejar
import json
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
from ctypes import wintypes

ROOT = pathlib.Path(__file__).resolve().parent.parent
DESTINATION = ROOT / 'artifacts' / 'vrchat-session.dpapi'
BASE = 'https://api.vrchat.cloud/api/1'
USER_AGENT = 'NocturnePlanet/1.0 (https://nocturne-planet.pages.dev)'


class Blob(ctypes.Structure):
    _fields_ = [('size', wintypes.DWORD), ('data', ctypes.POINTER(ctypes.c_ubyte))]


def protect(raw):
    buffer = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
    source = Blob(len(raw), buffer)
    output = Blob()
    encrypt = ctypes.windll.crypt32.CryptProtectData
    encrypt.argtypes = [ctypes.POINTER(Blob), wintypes.LPCWSTR, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    encrypt.restype = wintypes.BOOL
    release = ctypes.windll.kernel32.LocalFree
    release.argtypes = [ctypes.c_void_p]
    release.restype = ctypes.c_void_p
    if not encrypt(ctypes.byref(source), 'Nocturne Planet VRChat', None, None, None, 1, ctypes.byref(output)):
        raise RuntimeError('接続情報を暗号化できませんでした。')
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        release(output.data)


def main():
    if sys.platform != 'win32':
        raise RuntimeError('この接続画面はWindows用です。')
    print('のくぷら・本人確認用VRChatアカウントの接続')
    print('専用アカウントを入力してください。入力内容はチャット・GitHubへ送られません。')
    print('パスワードは保存せず、VRChatへ直接送信してログインします。')
    username = input('専用アカウントのログイン名またはメール: ').strip()
    password = getpass.getpass('パスワード（画面には表示されません）: ')
    if not username or not password:
        raise RuntimeError('入力がありません。接続を中止しました。')
    jar = http.cookiejar.CookieJar()
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None

    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), NoRedirect())

    def request(path, data=None, authorization=None):
        headers = {'User-Agent': USER_AGENT, 'Accept': 'application/json'}
        if authorization:
            headers['Authorization'] = authorization
        if data is not None:
            headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(BASE + path, data=None if data is None else json.dumps(data).encode(), headers=headers)
        with opener.open(req, timeout=20) as response:
            return json.loads(response.read(256000))

    basic = base64.b64encode((urllib.parse.quote(username, safe='') + ':' + urllib.parse.quote(password, safe='')).encode()).decode()
    account = request('/auth/user', authorization='Basic ' + basic)
    password = basic = None
    factors = account.get('requiresTwoFactorAuth', [])
    if factors:
        method = 'totp' if 'totp' in factors else 'emailotp' if 'emailOtp' in factors else None
        if not method:
            raise RuntimeError('このアカウントの二段階認証方式には対応していません。')
        message = '認証アプリのコード' if method == 'totp' else 'VRChatからメールで届いたコード'
        code = getpass.getpass(message + '（画面には表示されません）: ').strip()
        checked = request('/auth/twofactorauth/' + method + '/verify', {'code': code})
        code = None
        if not checked.get('verified'):
            raise RuntimeError('二段階認証を確認できませんでした。')
        account = request('/auth/user')
    auth = next((cookie.value for cookie in jar if cookie.name == 'auth'), None)
    two_factor = next((cookie.value for cookie in jar if cookie.name == 'twoFactorAuth'), '')
    if not auth or not str(account.get('id', '')).startswith('usr_'):
        raise RuntimeError('専用アカウントの接続を確認できませんでした。')
    payload = json.dumps({'auth': auth, 'twoFactorAuth': two_factor, 'id': account['id'], 'display_name': account.get('displayName', ''), 'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}).encode()
    DESTINATION.parent.mkdir(exist_ok=True)
    DESTINATION.write_bytes(protect(payload))
    print('接続できました。接続情報は、このWindowsユーザーだけが復号できる形で保存しました。')
    print('この画面を閉じて、チャットで「接続できた」とお知らせください。')


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        print(f'VRChatに接続できませんでした（HTTP {error.code}）。入力内容や時間を確認して再実行してください。')
    except Exception:
        print('接続を完了できませんでした。入力内容を表示せず処理を終了しました。')
    input('Enterで閉じる: ')
