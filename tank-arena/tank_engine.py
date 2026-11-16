"""Authoritative multiplayer simulation for the browser tank game."""

import json
import heapq
import math
import random
import re
import secrets
import threading
import time
import unicodedata
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

TICK = 1 / 50
RADIUS = 18
BULLET_RADIUS = 3
SPEED = 156
TURN_RATE = 3.25
BULLET_SPEED = 460
ROUND_SECONDS = 180
KILL_LIMIT = 5
INPUT_TIMEOUT = 0.5
OFFLINE_AFTER = 8
RECONNECT_FOR = 45
EPSILON = 1e-7
COLORS = ("#4f80d5", "#d26358", "#46a480", "#a27ac7")
INPUT_KEYS = ("forward", "backward", "left", "right", "fire")
PICKUPS = ("heal", "double", "heavy", "shield")


class TankError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class Player:
    id: str
    name: str
    color: str
    token: str = ""
    bot: bool = False
    connected: bool = True
    seen: float = 0.0
    input_seen: float = 0.0
    seq: int = -1
    inputs: tuple = (False,) * 5
    x: float = 0.0
    y: float = 0.0
    angle: float = 0.0
    hp: int = 100
    kills: int = 0
    deaths: int = 0
    respawn_at: float = 0.0
    shield_until: float = 0.0
    weapon: str = "normal"
    weapon_until: float = 0.0
    next_shot: float = 0.0
    bot_turn: float = 0.0
    bot_heading: float = 0.0
    bot_path: list = field(default_factory=list)


@dataclass
class Bullet:
    id: int
    owner_id: str
    x: float
    y: float
    vx: float
    vy: float
    kind: str
    damage: int
    bounces: int = 0


@dataclass
class Room:
    code: str
    map: dict
    practice: bool
    host_id: str
    players: dict = field(default_factory=dict)
    bullets: list = field(default_factory=list)
    pickups: list = field(default_factory=list)
    events: deque = field(default_factory=lambda: deque(maxlen=64))
    phase: str = "lobby"
    countdown_until: float = 0.0
    finish_at: float = 0.0
    next_pickup: float = 0.0
    winner_id: str = None
    tick: int = 0
    object_id: int = 0

    def next_id(self):
        self.object_id += 1
        return self.object_id

    def event(self, event_type, x, y, text=None, **details):
        event = {"id": self.next_id(), "type": event_type, "x": x, "y": y}
        event.update(details)
        if text:
            event["text"] = text
        self.events.append(event)


def _bounds(wall, margin=0):
    return (wall["x"] - margin, wall["y"] - margin,
            wall["x"] + wall["w"] + margin, wall["y"] + wall["h"] + margin)


def _wall_overlap(x, y, wall, radius):
    left, top, right, bottom = _bounds(wall)
    near_x = min(right, max(left, x))
    near_y = min(bottom, max(top, y))
    return (x - near_x) ** 2 + (y - near_y) ** 2 < radius ** 2 - EPSILON


def _clear(room, x, y, exclude=None, radius=RADIUS, clearance=0):
    width, height = room.map["width"], room.map["height"]
    if not radius <= x <= width - radius or not radius <= y <= height - radius:
        return False
    if any(_wall_overlap(x, y, wall, radius) for wall in room.map["walls"]):
        return False
    return all(
        other.id == exclude or other.hp <= 0 or not other.connected
        or (x - other.x) ** 2 + (y - other.y) ** 2 >= (radius + RADIUS + clearance) ** 2 - EPSILON
        for other in room.players.values()
    )


def _rectangle_hit(x, y, dx, dy, bounds):
    """Return impact fraction and reflected axes on entering the rectangle."""
    lower_x, lower_y, upper_x, upper_y = bounds
    starts = []
    ends = []
    for point, delta, low, high in ((x, dx, lower_x, upper_x), (y, dy, lower_y, upper_y)):
        if abs(delta) <= EPSILON:
            if point <= low or point >= high:
                return None
            starts.append(-math.inf)
            ends.append(math.inf)
            continue
        first, second = (low - point) / delta, (high - point) / delta
        starts.append(min(first, second))
        ends.append(max(first, second))
    start, end = max(starts), min(ends)
    if start < -EPSILON or start > 1 + EPSILON or end <= start + EPSILON:
        return None
    return max(0.0, start), abs(starts[0] - start) <= EPSILON, abs(starts[1] - start) <= EPSILON


def _wall_hit(game_map, x, y, dx, dy):
    best = None

    def consider(fraction, flip_x, flip_y):
        nonlocal best
        if not -EPSILON <= fraction <= 1 + EPSILON:
            return
        fraction = min(1.0, max(0.0, fraction))
        if best is None or fraction < best[0] - EPSILON:
            best = (fraction, flip_x, flip_y)
        elif abs(fraction - best[0]) <= EPSILON:
            best = (best[0], best[1] or flip_x, best[2] or flip_y)

    if abs(dx) > EPSILON:
        edge = game_map["width"] - BULLET_RADIUS if dx > 0 else BULLET_RADIUS
        consider((edge - x) / dx, True, False)
    if abs(dy) > EPSILON:
        edge = game_map["height"] - BULLET_RADIUS if dy > 0 else BULLET_RADIUS
        consider((edge - y) / dy, False, True)
    for wall in game_map["walls"]:
        hit = _rectangle_hit(x, y, dx, dy, _bounds(wall, BULLET_RADIUS))
        if hit:
            consider(*hit)
    return best


def _circle_hit(x, y, dx, dy, cx, cy, radius):
    ox, oy = x - cx, y - cy
    c = ox * ox + oy * oy - radius * radius
    if c <= 0:
        return 0.0
    a = dx * dx + dy * dy
    if a <= EPSILON:
        return None
    b = ox * dx + oy * dy
    disc = b * b - a * c
    if b >= 0 or disc < 0:
        return None
    impact = (-b - math.sqrt(disc)) / a
    return impact if 0 <= impact <= 1 else None


class TankManager:
    def __init__(self, maps_path, autostart=True):
        with Path(maps_path).open(encoding="utf-8") as source:
            definitions = json.load(source)
        self.maps = {entry["id"]: entry for entry in definitions}
        if not self.maps or len(self.maps) != len(definitions):
            raise ValueError("坦克地图列表为空或包含重复编号")
        self.rooms = {}
        self.clock = 0.0
        self.lock = threading.RLock()
        self._stop = threading.Event()
        self._thread = None
        self._random = random.Random()
        self._navigation = {}
        if autostart:
            self._thread = threading.Thread(target=self._run, name="tank-simulation", daemon=True)
            self._thread.start()

    @staticmethod
    def _payload(payload):
        if not isinstance(payload, dict):
            raise TankError(400, "请求格式不正确。")
        return payload

    @staticmethod
    def _name(payload):
        name = payload.get("name")
        if not isinstance(name, str):
            raise TankError(400, "请输入昵称。")
        name = "".join(char for char in name if unicodedata.category(char) not in {"Cc", "Cf", "Cs"}).strip()
        if not 1 <= len(name) <= 16:
            raise TankError(400, "昵称须为 1 至 16 个字符。")
        return name

    def _room(self, payload):
        code = payload.get("code")
        if not isinstance(code, str) or re.fullmatch(r"[0-9]{6}", code) is None:
            raise TankError(400, "请输入六位数字房间码。")
        room = self.rooms.get(code)
        if room is None:
            raise TankError(404, "找不到这个房间，可能已经关闭。")
        return room

    def _player(self, room, payload):
        token = payload.get("token")
        if not isinstance(token, str) or not token.isascii() or len(token) > 128:
            raise TankError(401, "房间会话已失效，请重新加入。")
        for player in room.players.values():
            if not player.bot and secrets.compare_digest(token.encode(), player.token.encode()):
                return player
        raise TankError(401, "房间会话已失效，请重新加入。")

    def _touch(self, room, player):
        if not player.connected and player.hp > 0 and not _clear(room, player.x, player.y, player.id):
            self._spawn(room, player)
        player.seen = self.clock
        player.connected = True
        if not room.host_id:
            room.host_id = player.id

    def _add_player(self, room, name, bot=False):
        colors = {player.color for player in room.players.values()}
        color = next(color for color in COLORS if color not in colors)
        player = Player(secrets.token_hex(6), name, color, "" if bot else secrets.token_urlsafe(24), bot, seen=self.clock)
        self._spawn(room, player, initial=True)
        room.players[player.id] = player
        return player

    def _session(self, room, player):
        return {"code": room.code, "token": player.token, "playerId": player.id, "state": self._state(room)}

    def create(self, payload):
        payload = self._payload(payload)
        name = self._name(payload)
        map_id = payload.get("mapId", "random")
        practice = payload.get("practice", False)
        if type(practice) is not bool or not isinstance(map_id, str):
            raise TankError(400, "地图或练习设置无效。")
        if map_id != "random" and map_id not in self.maps:
            raise TankError(400, "找不到选中的地图。")
        with self.lock:
            if len(self.rooms) >= 128:
                raise TankError(503, "房间过多，请稍后再试。")
            code = f"{secrets.randbelow(1_000_000):06d}"
            while code in self.rooms:
                code = f"{secrets.randbelow(1_000_000):06d}"
            game_map = self._random.choice(tuple(self.maps.values())) if map_id == "random" else self.maps[map_id]
            room = Room(code, game_map, practice, "")
            player = self._add_player(room, name)
            room.host_id = player.id
            self.rooms[code] = room
            return self._session(room, player)

    def join(self, payload):
        payload = self._payload(payload)
        name = self._name(payload)
        with self.lock:
            room = self._room(payload)
            if room.practice:
                raise TankError(409, "练习房间只允许一位玩家。")
            if room.phase != "lobby":
                raise TankError(409, "对局已经开始，请等待下一局。")
            if len(room.players) >= 4:
                raise TankError(409, "房间已满。")
            if any(player.name.casefold() == name.casefold() for player in room.players.values()):
                raise TankError(409, "房间里已有同名玩家，请换个昵称。")
            player = self._add_player(room, name)
            if not room.host_id:
                room.host_id = player.id
            return self._session(room, player)

    def sync(self, payload):
        payload = self._payload(payload)
        seq = payload.get("seq")
        inputs = tuple(payload.get(key, False) for key in INPUT_KEYS)
        if type(seq) is not int or not 0 <= seq < 2 ** 53 or any(type(value) is not bool for value in inputs):
            raise TankError(400, "操作数据无效。")
        with self.lock:
            room = self._room(payload)
            player = self._player(room, payload)
            self._touch(room, player)
            if seq > player.seq:
                player.seq = seq
                player.input_seen = self.clock
                player.inputs = inputs if room.phase == "playing" else (False,) * 5
            return {"state": self._state(room)}

    def _begin(self, payload, expected_phase):
        payload = self._payload(payload)
        with self.lock:
            room = self._room(payload)
            player = self._player(room, payload)
            self._touch(room, player)
            if player.id != room.host_id:
                raise TankError(403, "只有房主可以开始对局。")
            if room.phase != expected_phase:
                raise TankError(409, "当前不能开始新一局。")
            if room.practice and len(room.players) == 1:
                bot_name = "练习坦克" if player.name != "练习坦克" else "训练对手"
                self._add_player(room, bot_name, bot=True)
            if sum(other.connected for other in room.players.values()) < 2:
                raise TankError(409, "至少需要两位在线玩家。")
            room.bullets.clear()
            room.pickups.clear()
            room.events.clear()
            room.winner_id = None
            room.phase = "countdown"
            room.countdown_until = self.clock + 3
            room.finish_at = room.countdown_until + ROUND_SECONDS
            room.next_pickup = room.countdown_until + 6
            for other in room.players.values():
                other.kills = other.deaths = 0
                other.inputs = (False,) * 5
                other.hp = 0
                other.next_shot = 0
            for other in room.players.values():
                self._spawn(room, other, initial=True)
            return {"state": self._state(room)}

    def start(self, payload):
        return self._begin(payload, "lobby")

    def rematch(self, payload):
        return self._begin(payload, "finished")

    def leave(self, payload):
        payload = self._payload(payload)
        with self.lock:
            room = self._room(payload)
            player = self._player(room, payload)
            del room.players[player.id]
            self._maintain_room(room)
            return {"ok": True}

    def _state(self, room):
        def seconds(deadline):
            return max(0, round(deadline - self.clock, 3))

        return {
            "code": room.code, "hostId": room.host_id, "phase": room.phase,
            "mapId": room.map["id"], "map": room.map,
            "players": [{
                "id": p.id, "name": p.name, "color": p.color, "x": round(p.x, 3), "y": round(p.y, 3),
                "angle": round(p.angle, 5), "hp": p.hp, "kills": p.kills, "deaths": p.deaths,
                "connected": p.connected, "bot": p.bot,
                "respawnIn": seconds(p.respawn_at), "shield": seconds(p.shield_until),
                "weapon": p.weapon if p.weapon_until > self.clock else "normal",
                "weaponRemaining": seconds(p.weapon_until), "fireCooldown": seconds(p.next_shot),
            } for p in room.players.values()],
            "bullets": [{
                "id": b.id, "ownerId": b.owner_id, "x": round(b.x, 3), "y": round(b.y, 3),
                "vx": round(b.vx, 3), "vy": round(b.vy, 3), "bounces": b.bounces, "kind": b.kind,
            } for b in room.bullets],
            "pickups": [item.copy() for item in room.pickups],
            "remaining": seconds(room.finish_at) if room.phase == "playing" else ROUND_SECONDS if room.phase in {"lobby", "countdown"} else 0,
            "countdown": seconds(room.countdown_until) if room.phase == "countdown" else 0,
            "winnerId": room.winner_id, "events": [event.copy() for event in room.events],
            "tick": room.tick, "mode": "practice" if room.practice else "online",
        }

    def _practice_spawn(self, room, player, occupied):
        """Find a nearby, reachable opponent spawn only when that opponent respawns."""
        humans = [other for other in occupied if not other.bot]
        if not room.practice or not player.bot or not humans:
            return None
        target = humans[0]
        candidates = []
        for distance in (420, 540, 360, 630):
            for index in range(24):
                angle = index * math.tau / 24
                x = target.x + math.cos(angle) * distance
                y = target.y + math.sin(angle) * distance
                if not _clear(room, x, y, player.id, radius=RADIUS + 4):
                    continue
                if any(math.hypot(x - other.x, y - other.y) < 300 for other in occupied):
                    continue
                # A wall between the tanks gives the player time to find and approach the bot.
                exposed = _wall_hit(room.map, x, y, target.x - x, target.y - y) is None
                candidates.append((exposed, abs(distance - 450), index, x, y))
        for _, _, _, x, y in sorted(candidates):
            route = self._route(room.map, x, y, target.x, target.y)
            if not route:
                continue
            previous = (x, y)
            length = 0
            for point in route:
                length += math.dist(previous, point)
                previous = point
            if length <= 1100:
                return {"x": x, "y": y, "angle": math.atan2(target.y - y, target.x - x)}
        return None

    def _spawn(self, room, player, initial=False):
        occupied = [other for other in room.players.values() if other.id != player.id and other.connected and other.hp > 0]
        candidates = [point for point in room.map["spawns"] if _clear(room, point["x"], point["y"], player.id)]
        if not candidates:
            for y in range(32, room.map["height"] - 30, 24):
                for x in range(32, room.map["width"] - 30, 24):
                    if _clear(room, x, y, player.id):
                        candidates.append({"x": x, "y": y, "angle": 0})
            if not candidates:
                return
        spawn = candidates[0]
        if not initial and occupied:
            spawn = max(candidates, key=lambda point: min(
                (point["x"] - other.x) ** 2 + (point["y"] - other.y) ** 2 for other in occupied
            ))
        spawn = self._practice_spawn(room, player, occupied) or spawn
        player.x, player.y, player.angle = spawn["x"], spawn["y"], spawn["angle"]
        player.hp = 100
        player.respawn_at = 0.0
        player.shield_until = (room.countdown_until if room.phase == "countdown" else self.clock) + 2
        player.weapon = "normal"
        player.weapon_until = 0.0
        player.bot_path.clear()
        player.bot_turn = 0.0

    def _maintain_room(self, room):
        expired = []
        for player in room.players.values():
            if player.bot:
                continue
            idle = self.clock - player.seen
            if idle >= RECONNECT_FOR:
                expired.append(player.id)
            elif idle >= OFFLINE_AFTER:
                player.connected = False
                player.inputs = (False,) * 5
        for player_id in expired:
            del room.players[player_id]
        humans = [player for player in room.players.values() if not player.bot]
        if not humans:
            self.rooms.pop(room.code, None)
            return False
        host = room.players.get(room.host_id)
        if host is None or not host.connected:
            room.host_id = next((player.id for player in humans if player.connected), "")
        return True

    def _run(self):
        previous = time.monotonic()
        pending = 0.0
        while not self._stop.wait(TICK * 0.5):
            now = time.monotonic()
            pending += min(now - previous, 0.2)
            previous = now
            if pending < TICK:
                continue
            ticks = int(pending / TICK)
            pending -= ticks * TICK
            self.step(ticks * TICK)

    def close(self):
        self._stop.set()
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=1)

    def step(self, dt):
        if not isinstance(dt, (float, int)) or not math.isfinite(dt) or dt < 0:
            raise ValueError("无效的模拟时间")
        with self.lock:
            while dt > EPSILON:
                interval = min(dt, TICK)
                dt -= interval
                self.clock += interval
                for room in tuple(self.rooms.values()):
                    room.tick += 1
                    if self._maintain_room(room):
                        self._update(room, interval)

    def _update(self, room, dt):
        if room.phase == "countdown" and self.clock + EPSILON >= room.countdown_until:
            room.phase = "playing"
        if room.phase != "playing":
            return
        if self.clock + EPSILON >= room.finish_at:
            best = max((player.kills for player in room.players.values()), default=0)
            leaders = [player.id for player in room.players.values() if player.kills == best]
            self._finish(room, leaders[0] if len(leaders) == 1 else None)
            return
        for player in room.players.values():
            if not player.connected:
                continue
            if player.hp <= 0:
                if self.clock + EPSILON >= player.respawn_at:
                    self._spawn(room, player)
                continue
            if player.bot:
                self._bot(room, player)
            forward, backward, left, right, fire = player.inputs
            if not player.bot and self.clock - player.input_seen > INPUT_TIMEOUT:
                forward = backward = left = right = fire = False
            player.angle = (player.angle + (int(right) - int(left)) * TURN_RATE * dt) % math.tau
            travel = (int(forward) - int(backward) * 0.70) * SPEED * dt
            if travel:
                self._move(room, player, travel)
            if fire and self.clock + EPSILON >= player.next_shot:
                self._fire(room, player)
        remaining = []
        for bullet in room.bullets:
            if self._bullet_step(room, bullet, dt):
                remaining.append(bullet)
            if room.phase != "playing":
                return
        room.bullets = remaining
        self._pickups(room)

    @staticmethod
    def _move(room, player, travel):
        # Each 50 Hz displacement is at most 3.12 px. Axis checks permit wall sliding.
        dx, dy = math.cos(player.angle) * travel, math.sin(player.angle) * travel
        if _clear(room, player.x + dx, player.y, player.id):
            player.x += dx
        if _clear(room, player.x, player.y + dy, player.id):
            player.y += dy

    def _fire(self, room, player):
        player.next_shot = self.clock + 1.0
        kind = player.weapon if self.clock < player.weapon_until else "normal"
        room.event("fire", player.x, player.y, playerId=player.id,
                   angle=player.angle, weapon=kind, color=player.color)
        shots = ((-0.12, 20), (0.12, 20)) if kind == "double" else ((0, 40 if kind == "heavy" else 25),)
        for offset, damage in shots:
            angle = player.angle + offset
            ux, uy = math.cos(angle), math.sin(angle)
            barrel = RADIUS + BULLET_RADIUS + 2
            impact = _wall_hit(room.map, player.x, player.y, ux * barrel, uy * barrel)
            # Start inside the playable area; the next sweep handles the nearby wall.
            if impact:
                barrel *= max(0, impact[0] - 0.01)
            room.bullets.append(Bullet(room.next_id(), player.id, player.x + ux * barrel,
                                       player.y + uy * barrel, ux * BULLET_SPEED, uy * BULLET_SPEED, kind, damage))

    def _bullet_step(self, room, bullet, dt):
        while dt > EPSILON:
            dx, dy = bullet.vx * dt, bullet.vy * dt
            wall = _wall_hit(room.map, bullet.x, bullet.y, dx, dy)
            distance = wall[0] if wall else 1 + EPSILON
            target = None
            for player in room.players.values():
                if not player.connected or player.hp <= 0 or (player.id == bullet.owner_id and not bullet.bounces):
                    continue
                impact = _circle_hit(bullet.x, bullet.y, dx, dy, player.x, player.y, RADIUS + BULLET_RADIUS)
                if impact is not None and impact < distance:
                    distance, target = impact, player
            if target:
                bullet.x += dx * distance
                bullet.y += dy * distance
                self._hit(room, bullet, target)
                return False
            if wall is None:
                bullet.x += dx
                bullet.y += dy
                return True
            fraction, flip_x, flip_y = wall
            bullet.x += dx * fraction
            bullet.y += dy * fraction
            bullet.bounces += 1
            room.event("bounce", bullet.x, bullet.y)
            if bullet.bounces >= 10:
                return False
            if flip_x:
                bullet.vx = -bullet.vx
            if flip_y:
                bullet.vy = -bullet.vy
            bullet.x += bullet.vx * EPSILON
            bullet.y += bullet.vy * EPSILON
            dt *= 1 - fraction
        return True

    def _hit(self, room, bullet, target):
        if target.shield_until > self.clock + EPSILON:
            room.event("hit", bullet.x, bullet.y, "护盾挡下了一发炮弹",
                       playerId=target.id, targetId=target.id, sourceId=bullet.owner_id,
                       damage=0, blocked=True, color=target.color)
            return
        damage = min(target.hp, bullet.damage)
        target.hp = max(0, target.hp - bullet.damage)
        room.event("hit", bullet.x, bullet.y, playerId=target.id, targetId=target.id,
                   sourceId=bullet.owner_id, damage=damage, blocked=False, color=target.color)
        if target.hp > 0:
            return
        target.deaths += 1
        target.respawn_at = self.clock + 3
        owner = room.players.get(bullet.owner_id)
        if owner and owner.id != target.id:
            owner.kills += 1
            room.event("kill", target.x, target.y, f"{owner.name} 击毁了 {target.name}",
                       playerId=owner.id, sourceId=owner.id, targetId=target.id, color=target.color)
            if owner.kills >= KILL_LIMIT:
                self._finish(room, owner.id)
        else:
            room.event("kill", target.x, target.y, f"{target.name} 被反弹炮弹击毁",
                       playerId=target.id, sourceId=bullet.owner_id, targetId=target.id, color=target.color)

    @staticmethod
    def _finish(room, winner_id):
        room.phase = "finished"
        room.winner_id = winner_id
        room.bullets.clear()
        for player in room.players.values():
            player.inputs = (False,) * 5

    def _pickups(self, room):
        area_ratio = room.map["width"] * room.map["height"] / (1200 * 760)
        capacity = min(12, max(4, math.ceil(4 * area_ratio)))
        if self.clock + EPSILON >= room.next_pickup and len(room.pickups) < capacity:
            room.next_pickup = self.clock + (8 if area_ratio > 2 else 12)
            count = min(capacity - len(room.pickups), 4 if area_ratio > 2 else 1)
            columns, rows = (3, 2) if area_ratio > 2 else (1, 1)
            width, height = room.map["width"] / columns, room.map["height"] / rows
            for _ in range(count):
                regions = [(sum(int(item["x"] / width) == column and int(item["y"] / height) == row
                                for item in room.pickups), self._random.random(), column, row)
                           for row in range(rows) for column in range(columns)]
                # Replenish sparse parts of a large battlefield instead of clustering all supplies.
                for _, _, column, row in sorted(regions):
                    placed = False
                    for _ in range(70):
                        x = self._random.randint(math.ceil(column * width + 28), math.floor((column + 1) * width - 28))
                        y = self._random.randint(math.ceil(row * height + 28), math.floor((row + 1) * height - 28))
                        if _clear(room, x, y, clearance=15) and all(
                            (x - item["x"]) ** 2 + (y - item["y"]) ** 2 >= min(120, 55 * math.sqrt(area_ratio)) ** 2
                            for item in room.pickups
                        ):
                            room.pickups.append({"id": room.next_id(), "type": self._random.choice(PICKUPS), "x": x, "y": y})
                            placed = True
                            break
                    if placed:
                        break
        available = []
        for item in room.pickups:
            player = next((p for p in room.players.values() if p.connected and p.hp > 0
                and (p.x - item["x"]) ** 2 + (p.y - item["y"]) ** 2 <= (RADIUS + 13) ** 2
                and (item["type"] != "heal" or p.hp < 100)), None)
            if not player:
                available.append(item)
                continue
            kind = item["type"]
            if kind == "heal":
                player.hp = min(100, player.hp + 45)
            elif kind == "shield":
                player.shield_until = self.clock + 6
            else:
                player.weapon, player.weapon_until = kind, self.clock + 15
            label = {"heal": "医疗包", "shield": "护盾", "double": "双发升级", "heavy": "重炮升级"}[kind]
            room.event("pickup", item["x"], item["y"], f"{player.name} 拾取了{label}",
                       playerId=player.id, kind=kind)
        room.pickups = available

    @staticmethod
    def _drive_clear(game_map, x, y, tx, ty):
        margin = RADIUS + 4
        left, right = min(x, tx), max(x, tx)
        top, bottom = min(y, ty), max(y, ty)
        for wall in game_map["walls"]:
            bounds = _bounds(wall, margin)
            if right < bounds[0] or left > bounds[2] or bottom < bounds[1] or top > bounds[3]:
                continue
            if bounds[0] < x < bounds[2] and bounds[1] < y < bounds[3]:
                # A tank can touch a rounded wall corner inside the conservative navigation
                # rectangle. Only permit a route that moves away from an exposed wall face.
                escaping = (x < wall["x"] and tx <= x or x > wall["x"] + wall["w"] and tx >= x
                            or y < wall["y"] and ty <= y or y > wall["y"] + wall["h"] and ty >= y)
                if not escaping:
                    return False
                continue
            if _rectangle_hit(x, y, tx - x, ty - y, bounds):
                return False
        return True

    def _route(self, game_map, x, y, tx, ty):
        """A small cached navigation grid is only needed by practice opponents."""
        key = id(game_map)
        step = 48
        if key not in self._navigation:
            margin = RADIUS + 4
            points = {}
            bounds = [_bounds(wall, margin) for wall in game_map["walls"]]
            for row in range(math.ceil(game_map["height"] / step)):
                py = min(game_map["height"] - margin, row * step + step / 2)
                for column in range(math.ceil(game_map["width"] / step)):
                    px = min(game_map["width"] - margin, column * step + step / 2)
                    if not any(left <= px <= right and top <= py <= bottom for left, top, right, bottom in bounds):
                        points[(column, row)] = (px, py)
            self._navigation[key] = (game_map, points, {})
        _, points, edges = self._navigation[key]

        def nearby(px, py):
            candidates = ((node, point) for node, point in points.items()
                          if abs(point[0] - px) <= step * 3 and abs(point[1] - py) <= step * 3)
            return next((node for node, point in sorted(candidates, key=lambda item:
                         (item[1][0] - px) ** 2 + (item[1][1] - py) ** 2)
                         if self._drive_clear(game_map, px, py, *point)), None)

        start, goal = nearby(x, y), nearby(tx, ty)
        if start is None or goal is None:
            return []
        frontier = [(0, 0, start)]
        costs, previous = {start: 0}, {}
        while frontier:
            _, distance, node = heapq.heappop(frontier)
            if node == goal:
                route = [(tx, ty)]
                while node != start:
                    route.append(points[node])
                    node = previous[node]
                route.append(points[start])
                return list(reversed(route))
            if distance != costs[node]:
                continue
            if node not in edges:
                column, row = node
                edges[node] = [adjacent for adjacent in ((column + 1, row), (column - 1, row),
                               (column, row + 1), (column, row - 1))
                               if adjacent in points and self._drive_clear(game_map, *points[node], *points[adjacent])]
            for adjacent in edges[node]:
                cost = distance + 1
                if cost >= costs.get(adjacent, math.inf):
                    continue
                costs[adjacent], previous[adjacent] = cost, node
                heuristic = abs(adjacent[0] - goal[0]) + abs(adjacent[1] - goal[1])
                heapq.heappush(frontier, (cost + heuristic, cost, adjacent))
        return []

    def _bot(self, room, player):
        targets = [other for other in room.players.values() if not other.bot and other.connected and other.hp > 0]
        if not targets:
            player.inputs = (False,) * 5
            return
        target = min(targets, key=lambda other: (other.x - player.x) ** 2 + (other.y - player.y) ** 2)
        dx, dy = target.x - player.x, target.y - player.y
        target_angle = math.atan2(dy, dx)
        visible = _wall_hit(room.map, player.x, player.y, dx, dy) is None
        direct = self._drive_clear(room.map, player.x, player.y, target.x, target.y)
        if direct:
            heading = target_angle
        else:
            if self.clock >= player.bot_turn:
                player.bot_path = self._route(room.map, player.x, player.y, target.x, target.y)
                player.bot_turn = self.clock + 0.8
                if not player.bot_path:
                    # Keep local escape behavior for unusually narrow custom maps.
                    headings = [target_angle, player.angle - 0.85, player.angle + 0.85,
                                player.angle - 1.57, player.angle + 1.57, player.angle + math.pi]
                    viable = [angle for angle in headings if _clear(room, player.x + 36 * math.cos(angle),
                                                                   player.y + 36 * math.sin(angle), player.id)]
                    player.bot_heading = self._random.choice(viable or headings)
            if player.bot_path:
                while len(player.bot_path) > 1 and math.hypot(player.bot_path[0][0] - player.x,
                                                             player.bot_path[0][1] - player.y) < 28:
                    player.bot_path.pop(0)
                for index in range(min(8, len(player.bot_path)) - 1, -1, -1):
                    point = player.bot_path[index]
                    if self._drive_clear(room.map, player.x, player.y, *point):
                        player.bot_path = player.bot_path[index:]
                        player.bot_heading = math.atan2(point[1] - player.y, point[0] - player.x)
                        break
            heading = player.bot_heading
        if visible and dx * dx + dy * dy <= 118 ** 2:
            heading = target_angle
        error = (heading - player.angle + math.pi) % math.tau - math.pi
        forward = abs(error) < 0.78 and (not direct or dx * dx + dy * dy > 118 ** 2)
        aim_error = (target_angle - player.angle + math.pi) % math.tau - math.pi
        # Half a simulation turn step avoids stopping just short of a safe corner heading.
        turn_tolerance = TURN_RATE * TICK / 2
        player.inputs = (forward, False, error < -turn_tolerance, error > turn_tolerance,
                         visible and abs(aim_error) < 0.15)
