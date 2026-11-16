"""Serve the local game gallery and keep collected links in SQLite."""

import argparse
import json
import mimetypes
import os
import re
import sqlite3
import threading
import time
import webbrowser
from collections import deque
from contextlib import closing
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import IPv4Address
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit, urlunsplit
from uuid import uuid4

from gomoku_engine import play
from tank_engine import TankError, TankManager

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / 'public'
DATABASE = ROOT / 'data' / 'games.sqlite3'
LOOPBACK = '127.0.0.1'
MAX_REQUEST_BYTES = 24 * 1024
PROJECT_ID = re.compile(r'(?:[0-9]{13}-)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}')
DOMAIN = re.compile(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})')
LOCAL_SUFFIXES = ('.localhost', '.local', '.internal', '.lan', '.test', '.invalid', '.example', '.onion', '.home.arpa')
PLAY_PAGES = {'gomoku': '/gomoku.html', 'frog-run': '/frog-run.html', 'tanks': '/tank-game.html'}
TANK_ACTIONS = {'create', 'join', 'sync', 'start', 'rematch', 'leave', 'bots'}
TANK_SHARED_ASSETS = {'/game.html', '/game.js', '/game-examples.js', '/style.css', '/game.css'}
TANK_PWA_ASSETS = {'/tank.webmanifest', '/mobile-install.js', '/games/tanks/sw.js'}
TANK_ASSET = re.compile(r'/tank-[a-z0-9-]+\.(?:html|js|css|json|png|webp|svg|ogg|mp3|wav)')
TANK_ROOM_RATE = 30
TANK_RATE_WINDOW = 60
CONTENT_TYPES = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
                 '.js': 'text/javascript; charset=utf-8', '.py': 'text/plain; charset=utf-8',
                 '.webmanifest': 'application/manifest+json; charset=utf-8'}
PAGE_POLICY = '; '.join((
    "default-src 'none'",
    "base-uri 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
))


class RequestError(Exception):
    def __init__(self, status, message, allow=None):
        super().__init__(message)
        self.status = status
        self.allow = allow


def public_origin(value):
    if not value:
        return ''
    error = ValueError('公网地址必须是完整的 HTTP 或 HTTPS 域名地址，不能包含子路径。')
    if re.search(r'[\x00-\x20\x7f\\@?#]', value):
        raise error
    try:
        parts = urlsplit(value)
        host = (parts.hostname or '').encode('idna').decode('ascii').lower()
        port = parts.port
    except (ValueError, UnicodeError):
        raise error from None
    if parts.scheme not in {'http', 'https'} or parts.path not in {'', '/'} or not DOMAIN.fullmatch(host):
        raise error
    default_port = 443 if parts.scheme == 'https' else 80
    authority = f'{host}:{port}' if port is not None and port != default_port else host
    return f'{parts.scheme}://{authority}'


def connect(path):
    database = sqlite3.connect(path, timeout=5)
    database.row_factory = sqlite3.Row
    return database


def initialize_database(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with closing(connect(path)) as database, database:
        database.execute('''
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                url TEXT NOT NULL,
                createdAt TEXT NOT NULL
            )
        ''')


def text_field(data, key, label, limit):
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise RequestError(400, f'请填写{label}。')
    value = value.strip()
    if len(value) > limit:
        raise RequestError(400, f'{label}最多可填写 {limit} 个字符。')
    if re.search(r'[\x00-\x08\x0b-\x1f\x7f\ud800-\udfff]', value):
        raise RequestError(400, f'{label}含有无法保存的字符。')
    return value


def game_url(value):
    error = RequestError(400, '请输入可公开访问的 HTTPS 游戏网址。')
    if not isinstance(value, str):
        raise error
    value = value.strip()
    if len(value) > 2000 or re.search(r'[\x00-\x20\x7f\\\ud800-\udfff]', value):
        raise error
    try:
        parts = urlsplit(value)
        if parts.scheme != 'https' or '@' in parts.netloc or not parts.hostname:
            raise error
        host = parts.hostname.encode('idna').decode('ascii').lower()
        port = parts.port
    except (ValueError, UnicodeError):
        raise error from None
    domain = host.rstrip('.')
    if len(domain) > 253 or not DOMAIN.fullmatch(domain) or domain.endswith(LOCAL_SUFFIXES):
        raise error
    netloc = f'{host}:{port}' if port is not None and port != 443 else host
    result = urlunsplit((
        'https', netloc,
        quote(parts.path or '/', safe="/%:@!$&'()*+,;=-._~"),
        quote(parts.query, safe="/?%:@!$&'()*+,;=-._~"),
        quote(parts.fragment, safe="/?%:@!$&'()*+,;=-._~"),
    ))
    if len(result) > 2000:
        raise error
    return result


def project_from(payload):
    if not isinstance(payload, dict):
        raise RequestError(400, '请填写游戏资料。')
    return {
        'id': str(uuid4()),
        'title': text_field(payload, 'title', '游戏名称', 60),
        'description': text_field(payload, 'description', '游戏介绍', 200),
        'url': game_url(payload.get('url')),
        'createdAt': datetime.now(timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z'),
    }


class LocalGameServer(ThreadingHTTPServer):
    def __init__(self, port, database_path=DATABASE, public_path=PUBLIC, *, bind=LOOPBACK,
                 tank_only=False, public_url=''):
        self.database_path = Path(database_path)
        self.public_path = Path(public_path).resolve()
        self.tank_only = tank_only
        self.public_url = public_origin(public_url)
        bind_address = IPv4Address(bind)
        self.lan_ip = str(bind_address) if bind_address.is_private and not (
            bind_address.is_loopback or bind_address.is_unspecified
        ) else ''
        self.rate_lock = threading.Lock()
        self.room_requests = {}
        self.next_rate_cleanup = 0.0
        self.tanks = None
        if not tank_only:
            initialize_database(self.database_path)
        super().__init__((str(bind_address), port), LocalGameHandler)
        try:
            self.tanks = TankManager(self.public_path / 'tank-maps.json')
        except Exception:
            self.server_close()
            raise

    def server_close(self):
        if self.tanks is not None:
            self.tanks.close()
        super().server_close()

    def tank_config(self):
        url = self.public_url
        scope = 'public' if url else 'local'
        if not url and self.lan_ip:
            url = f'http://{self.lan_ip}:{self.server_port}'
            scope = 'lan'
        if not url:
            url = f'http://{LOOPBACK}:{self.server_port}'
        return {'scope': scope, 'shareUrls': [url + '/games/tanks/play']}

    def limit_room_requests(self, address):
        now = time.monotonic()
        cutoff = now - TANK_RATE_WINDOW
        with self.rate_lock:
            if now >= self.next_rate_cleanup:
                self.room_requests = {key: values for key, values in self.room_requests.items() if values[-1] > cutoff}
                self.next_rate_cleanup = now + TANK_RATE_WINDOW
            requests = self.room_requests.setdefault(address, deque())
            while requests and requests[0] <= cutoff:
                requests.popleft()
            if len(requests) >= TANK_ROOM_RATE:
                return False
            requests.append(now)
            return True


class LocalGameHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    disable_nagle_algorithm = True

    def setup(self):
        super().setup()
        self.connection.settimeout(8)

    def do_GET(self):
        self.dispatch()

    def do_HEAD(self):
        self.dispatch()

    def do_POST(self):
        self.dispatch()

    def do_DELETE(self):
        self.dispatch()

    def do_OPTIONS(self):
        self.dispatch()

    def do_PUT(self):
        self.dispatch()

    def do_PATCH(self):
        self.dispatch()

    def dispatch(self):
        lengths = self.headers.get_all('Content-Length', [])
        self.unread_body = 'Transfer-Encoding' in self.headers or bool(
            lengths and (len(lengths) != 1 or not re.fullmatch('0+', lengths[0]))
        )
        try:
            host = self.validate_host()
            path = unquote(self.path.partition('?')[0], errors='strict')
            if path == '/healthz':
                self.require_method('GET', 'HEAD')
                self.send_json({'ok': True})
            elif path.startswith('/api/'):
                self.route_api(path, host)
            else:
                self.serve_asset(path)
        except RequestError as error:
            headers = {'Allow': error.allow} if error.allow else {}
            self.send_json({'error': str(error)}, error.status, headers)
        except TankError as error:
            self.send_json({'error': error.message}, error.status)
        except UnicodeError:
            self.send_json({'error': '网址格式无效。'}, 400)
        except sqlite3.Error as error:
            self.log_error('SQLite: %s', error)
            self.send_json({'error': '暂时无法读写本地游戏库，请重试。'}, 503)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def local_hosts(self):
        port = self.server.server_port
        hosts = {f'{LOOPBACK}:{port}', f'localhost:{port}'}
        if port == 80:
            hosts.update((LOOPBACK, 'localhost'))
        return hosts

    def local_client(self, host):
        return host in self.local_hosts() and IPv4Address(self.client_address[0]).is_loopback

    def validate_host(self):
        hosts = self.headers.get_all('Host', [])
        if len(hosts) == 1:
            host = hosts[0].lower()
            external_host = urlsplit(self.server.public_url).netloc
            lan_ip = self.server.lan_ip
            lan_hosts = {f'{lan_ip}:{self.server.server_port}'} if lan_ip else set()
            if lan_ip and self.server.server_port == 80:
                lan_hosts.add(lan_ip)
            if self.local_client(host) or host in lan_hosts or (external_host and host == external_host):
                return host
        raise RequestError(403, '请通过服务已配置的地址访问。')

    def require_local_origin(self, host):
        origins = self.headers.get_all('Origin', [])
        if not self.local_client(host) or origins != [f'http://{host}']:
            raise RequestError(403, '请在本机网页中操作。')

    def require_tank_origin(self, host):
        public_url = self.server.public_url
        origin = public_url if public_url and urlsplit(public_url).netloc == host else f'http://{host}'
        if self.headers.get_all('Origin', []) != [origin]:
            raise RequestError(403, '请在已配置的坦克游戏页面中操作。')

    def read_json(self):
        if self.headers.get_content_type() != 'application/json':
            raise RequestError(415, '需要使用 JSON 格式。')
        sizes = self.headers.get_all('Content-Length', [])
        if len(sizes) != 1 or not re.fullmatch('[0-9]+', sizes[0]) or 'Transfer-Encoding' in self.headers:
            raise RequestError(400, '请求长度无效。')
        if len(sizes[0]) > 8 or int(sizes[0]) > MAX_REQUEST_BYTES:
            raise RequestError(413, '提交内容过长，请缩短后重试。')
        size = int(sizes[0])
        try:
            payload = self.rfile.read(size)
            if len(payload) != size:
                raise ValueError
            self.unread_body = False
            return json.loads(payload.decode('utf-8'))
        except (ValueError, TimeoutError, RecursionError):
            raise RequestError(400, '提交内容格式无效。') from None

    def route_api(self, path, host):
        if path.startswith('/api/tanks/'):
            self.route_tanks(path.removeprefix('/api/tanks/'), host)
            return
        if self.server.tank_only or not self.local_client(host):
            raise RequestError(404, '没有找到这个接口。')
        if path == '/api/gomoku':
            self.require_method('POST')
            self.require_local_origin(host)
            payload = self.read_json()
            try:
                state = play(payload)
            except ValueError as error:
                raise RequestError(400, str(error)) from None
            self.send_json(state)
            return
        if path == '/api/projects':
            self.require_method('GET', 'POST')
            if self.command == 'GET':
                with closing(connect(self.server.database_path)) as database:
                    projects = database.execute('SELECT * FROM projects ORDER BY createdAt DESC').fetchall()
                self.send_json({'projects': [dict(project) for project in projects]})
                return
            self.require_local_origin(host)
            project = project_from(self.read_json())
            with closing(connect(self.server.database_path)) as database, database:
                database.execute(
                    'INSERT INTO projects (id, title, description, url, createdAt) '
                    'VALUES (:id, :title, :description, :url, :createdAt)', project,
                )
            self.send_json({'project': project}, 201)
            return
        project_id = path.removeprefix('/api/projects/')
        if project_id == path or not PROJECT_ID.fullmatch(project_id):
            raise RequestError(404, '没有找到这款游戏。')
        self.require_method('GET', 'DELETE')
        if self.command == 'DELETE':
            self.require_local_origin(host)
            with closing(connect(self.server.database_path)) as database, database:
                database.execute('DELETE FROM projects WHERE id = ?', (project_id,))
            self.send_payload(204, b'', 'application/json; charset=utf-8', {'Cache-Control': 'no-store'})
            return
        with closing(connect(self.server.database_path)) as database:
            project = database.execute('SELECT * FROM projects WHERE id = ?', (project_id,)).fetchone()
        if project is None:
            raise RequestError(404, '没有找到这款游戏。')
        self.send_json({'project': dict(project)})

    def route_tanks(self, action, host):
        if action == 'config':
            self.require_method('GET', 'HEAD')
            self.send_json(self.server.tank_config())
            return
        if action not in TANK_ACTIONS:
            raise RequestError(404, '没有找到这个接口。')
        self.require_method('POST')
        self.require_tank_origin(host)
        # Only the socket peer is trusted. A browser-supplied forwarding header cannot change the quota.
        if action in {'create', 'join'} and not self.server.limit_room_requests(self.client_address[0]):
            self.send_json({'error': '创建或加入房间太频繁，请稍后再试。'}, 429, {'Retry-After': str(TANK_RATE_WINDOW)})
            return
        payload = self.read_json()
        handler = self.server.tanks.configure_bot if action == 'bots' else getattr(self.server.tanks, action)
        self.send_json(handler(payload))

    def require_method(self, *methods):
        if self.command not in methods:
            raise RequestError(405, '不支持这个请求方法。', ', '.join(methods))

    def serve_asset(self, path):
        self.require_method('GET', 'HEAD')
        if self.server.tank_only and path not in {'/', '/games/tanks', '/games/tanks/play'} and not (
            path in TANK_SHARED_ASSETS or path in TANK_PWA_ASSETS or TANK_ASSET.fullmatch(path)
        ):
            raise RequestError(404, '没有找到这个页面。')
        if path == '/games/tanks/sw.js':
            path = '/tank-service-worker.js'
        elif path == '/':
            path = '/tank-game.html' if self.server.tank_only else '/index.html'
        elif path.startswith('/games/'):
            segments = path.split('/')
            slug = segments[2]
            if len(segments) == 3 and (slug in PLAY_PAGES or PROJECT_ID.fullmatch(slug)):
                path = '/game.html'
            elif len(segments) == 4 and segments[3] == 'play' and slug in PLAY_PAGES:
                path = PLAY_PAGES[slug]
            else:
                raise RequestError(404, '没有找到这款游戏。')
        parts = path.split('/')[1:]
        if not path.startswith('/') or any(not part or part.startswith('.') or '\\' in part or '\x00' in part for part in parts):
            raise RequestError(404, '没有找到这个页面。')
        file = self.server.public_path.joinpath(*parts).resolve()
        if not file.is_relative_to(self.server.public_path) or not file.is_file():
            raise RequestError(404, '没有找到这个页面。')
        content_type = CONTENT_TYPES.get(file.suffix) or mimetypes.guess_type(file.name)[0] or 'application/octet-stream'
        headers = {'Cache-Control': 'no-cache'}
        if file.suffix == '.html':
            headers['Content-Security-Policy'] = PAGE_POLICY
        self.send_payload(200, file.read_bytes(), content_type, headers)

    def log_request(self, code='-', size='-'):
        if self.path.partition('?')[0] not in {'/api/tanks/sync', '/healthz'} or str(code).startswith('5'):
            super().log_request(code, size)

    def send_json(self, data, status=200, headers=None):
        payload = json.dumps(data, ensure_ascii=False).encode('utf-8')
        response_headers = {'Cache-Control': 'no-store', **(headers or {})}
        self.send_payload(status, payload, 'application/json; charset=utf-8', response_headers)

    def send_payload(self, status, payload, content_type, headers):
        self.send_response(status)
        if status >= 400 or self.unread_body or self.close_connection:
            self.send_header('Connection', 'close')
        self.send_header('Content-Type', content_type)
        if status != 204:
            self.send_header('Content-Length', str(len(payload)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'same-origin')
        self.send_header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != 'HEAD' and payload:
            self.wfile.write(payload)


def main():
    parser = argparse.ArgumentParser(description='在本机运行像素工坊。')
    parser.add_argument('--port', type=int, default=os.environ.get('PORT', '8765'), help='服务端口（默认 8765）')
    parser.add_argument('--bind', default=LOOPBACK, help='监听 IPv4 地址（默认 127.0.0.1）')
    parser.add_argument('--tank-only', action='store_true', help='仅开放坦克对战页面和接口')
    parser.add_argument('--public-url', default=os.environ.get('RENDER_EXTERNAL_URL', ''), help='外部可访问的 HTTP 或 HTTPS 地址')
    parser.add_argument('--open', action='store_true', help='启动后打开默认浏览器')
    parser.add_argument('--data-dir', type=Path, default=DATABASE.parent, help='游戏资料目录（默认 data）')
    arguments = parser.parse_args()
    if not 0 <= arguments.port <= 65535:
        parser.error('端口必须在 0 至 65535 之间。')
    if not PUBLIC.is_dir():
        parser.error('缺少 public 游戏文件夹，请保留解压后的完整目录。')
    try:
        server = LocalGameServer(arguments.port, database_path=arguments.data_dir / DATABASE.name,
                                 bind=arguments.bind, tank_only=arguments.tank_only, public_url=arguments.public_url)
    except (OSError, sqlite3.Error, ValueError) as error:
        parser.exit(1, f'无法启动像素工坊：{error}\n')
    url = server.public_url or f'http://{server.lan_ip or LOOPBACK}:{server.server_port}/'
    with server:
        print(f'像素工坊已启动：{url}', flush=True)
        print('按 Ctrl+C 停止。', flush=True)
        if arguments.open:
            threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
