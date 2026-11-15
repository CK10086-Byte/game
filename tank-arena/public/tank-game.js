(() => {
  'use strict';

  const byId = id => document.getElementById('tank-' + id);
  const ui = Object.fromEntries([
    'canvas', 'stage', 'status', 'lobby', 'room', 'name', 'code', 'create', 'join', 'practice', 'map-select',
    'map-grid', 'room-code', 'copy-invite', 'leave', 'start', 'rematch', 'player-list', 'scoreboard', 'timer',
    'map-name', 'phase', 'health', 'weapon', 'cooldown', 'connection', 'feedback', 'overlay', 'help-toggle',
    'help', 'help-close', 'sound', 'share-note', 'room-share-note', 'invite-text', 'view-toggle',
    'arena', 'fullscreen', 'joystick', 'joystick-knob',
  ].map(id => [id, byId(id)]));
  const inputButtons = Array.from(document.querySelectorAll('[data-tank-control]'));
  const actions = ['forward', 'backward', 'left', 'right', 'fire'];
  const keyActions = new Map([
    ['w', 'forward'], ['arrowup', 'forward'], ['s', 'backward'], ['arrowdown', 'backward'],
    ['a', 'left'], ['arrowleft', 'left'], ['d', 'right'], ['arrowright', 'right'], [' ', 'fire'],
  ]);
  const phaseLabels = { lobby: '等待开局', countdown: '即将开战', playing: '对战进行中', finished: '本局结束' };
  const weaponLabels = { normal: '普通炮弹', double: '双发炮弹', heavy: '重型炮弹' };
  const roomCode = /^[0-9]{6}$/;
  const sessionKey = 'pixel-workshop-tanks-session';
  const nicknameKey = 'pixel-workshop-tanks-name';
  const syncInterval = 50;
  const pressedKeys = new Map();
  const pressedPointers = new Map();
  const snapshots = [];
  const previews = [];
  const effects = [];
  let renderer;
  let maps = [];
  let config = { scope: 'local', shareUrls: [] };
  let session;
  let state;
  let operation = false;
  let restoring = false;
  let syncTimer;
  let syncing = false;
  let flushAfterSync = false;
  let syncFailures = 0;
  let lastSyncSent = 0;
  let lastSentInput = false;
  let lastEvent = 0;
  let fireTaps = 0;
  let muted = false;
  let overview = false;
  let immersive = false;
  let fullscreenBusy = false;
  const joystick = { pointerId: null, x: 0, y: 0, strength: 0, bounds: null };
  let audio;
  let feedbackUntil = 0;
  let listSignature = '';
  let overlaySignature = '';

  function readStorage(storage, key) {
    try { return storage().getItem(key); } catch { return null; }
  }

  function writeStorage(storage, key, value) {
    try {
      if (value === null) storage().removeItem(key);
      else storage().setItem(key, value);
    } catch { /* Private mode can disable storage. */ }
  }

  function saveSession() {
    writeStorage(() => sessionStorage, sessionKey, session ? JSON.stringify(session) : null);
  }

  function getSession() {
    try {
      const saved = JSON.parse(readStorage(() => sessionStorage, sessionKey));
      if (saved && roomCode.test(saved.code) && typeof saved.token === 'string' && saved.token &&
          typeof saved.playerId === 'string') {
        return { ...saved, seq: Number.isSafeInteger(saved.seq) && saved.seq >= 0 ? saved.seq : 0 };
      }
    } catch { /* An invalid saved session is discarded. */ }
    return undefined;
  }

  function node(tag, className, text) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (text !== undefined) result.textContent = text;
    return result;
  }

  function text(element, value) {
    const next = String(value);
    if (element && element.textContent !== next) element.textContent = next;
  }

  async function request(path, payload, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout ?? 2600);
    try {
      const response = await fetch(path, {
        method: payload === undefined ? 'GET' : 'POST',
        ...(payload === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }),
        cache: 'no-store',
        signal: controller.signal,
        ...(options.keepalive ? { keepalive: true } : {}),
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.error || '请求未成功，请重试。');
        error.status = response.status;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  function messageFor(error) {
    return error.status ? error.message : '暂时连不上本地服务。请确认启动窗口仍然打开。';
  }

  function actionPayload(current = session) {
    return { code: current.code, token: current.token };
  }

  function editable(target) {
    return target instanceof Element && Boolean(target.closest('input,textarea,select,[contenteditable]'));
  }

  function controlsAllowed() {
    if (!session || state?.phase !== 'playing' || syncFailures || document.hidden || ui.help?.open) return false;
    const me = state.players.find(player => player.id === session.playerId);
    return Boolean(me && me.hp > 0 && !me.respawnIn && me.connected);
  }

  function active(action) {
    return [...pressedKeys.values(), ...pressedPointers.values()].includes(action);
  }

  function renderViewButton() {
    if (ui.fullscreen) {
      ui.fullscreen.disabled = !immersive && !['countdown', 'playing'].includes(state?.phase);
      ui.fullscreen.title = ui.fullscreen.disabled ? '开始对战后可进入全屏' : '全屏对战';
    }
    if (!ui['view-toggle']) return;
    ui['view-toggle'].disabled = state?.phase !== 'playing';
    ui['view-toggle'].setAttribute('aria-pressed', String(overview));
    text(ui['view-toggle'], overview ? '跟随坦克' : '查看全图');
    if (ui.stage) ui.stage.dataset.view = overview ? 'overview' : 'follow';
  }

  function toggleOverview() {
    if (!session || state?.phase !== 'playing' || ui.help?.open) return;
    overview = !overview;
    renderViewButton();
    ui.canvas.focus({ preventScroll: true });
  }

  function setImmersive(enabled) {
    immersive = enabled;
    ui.arena?.classList.toggle('tank-immersive', enabled);
    document.body?.classList.toggle('tank-fullscreen', enabled);
    if (ui.fullscreen) {
      text(ui.fullscreen, enabled ? '退出' : '全屏');
      ui.fullscreen.setAttribute('aria-label', enabled ? '退出全屏' : '全屏对战');
      ui.fullscreen.setAttribute('aria-pressed', String(enabled));
    }
    renderViewButton();
    emergencyRelease();
    requestAnimationFrame(resize);
  }

  async function exitFullscreen() {
    if (document.fullscreenElement === ui.arena && document.exitFullscreen) {
      try { await document.exitFullscreen(); } catch { /* The exit button remains available. */ }
    }
    setImmersive(document.fullscreenElement === ui.arena);
  }

  async function toggleFullscreen() {
    if (!ui.arena || fullscreenBusy) return;
    if (!immersive && !['countdown', 'playing'].includes(state?.phase)) return;
    fullscreenBusy = true;
    try {
      if (immersive) {
        await exitFullscreen();
      } else {
        if (ui.arena.requestFullscreen) {
          try { await ui.arena.requestFullscreen(); } catch { /* Use a full-window view on unsupported browsers. */ }
        }
        setImmersive(true);
      }
      ui.canvas.focus({ preventScroll: true });
    } finally { fullscreenBusy = false; }
  }

  function resetJoystick() {
    joystick.pointerId = null;
    joystick.x = joystick.y = joystick.strength = 0;
    joystick.bounds = null;
    if (ui['joystick-knob']) ui['joystick-knob'].style.transform = 'translate(-50%, -50%)';
    ui.joystick?.classList.toggle('is-active', false);
  }

  function joystickActions() {
    if (joystick.strength < .18) return {};
    const me = state?.players.find(player => player.id === session?.playerId);
    if (!me) return {};
    const target = Math.atan2(joystick.y, joystick.x);
    const turn = Math.PI * 2;
    const delta = ((target - me.angle + Math.PI) % turn + turn) % turn - Math.PI;
    return { left: delta < -.12, right: delta > .12, forward: Math.abs(delta) < .72 };
  }

  function renderControls() {
    const allowed = controlsAllowed();
    ui.stage?.classList.toggle('can-control', allowed);
    ui.joystick?.setAttribute('aria-disabled', String(!allowed));
    for (const button of inputButtons) {
      const pressed = allowed && active(button.dataset.tankControl);
      button.classList.toggle('is-pressed', pressed);
      button.disabled = !allowed;
    }
  }

  function releaseInputs(immediate = true) {
    const hadInput = pressedKeys.size || pressedPointers.size || fireTaps || joystick.strength;
    pressedKeys.clear();
    pressedPointers.clear();
    fireTaps = 0;
    resetJoystick();
    renderControls();
    if (immediate && hadInput && session) queueSync(0);
  }

  function colorDot(player) {
    const dot = node('span', 'tank-player-dot');
    if (/^#[0-9a-f]{6}$/i.test(player.color)) {
      dot.style.backgroundColor = player.color;
      dot.setAttribute('aria-hidden', 'true');
    }
    return dot;
  }

  function renderPlayers() {
    const players = state.players;
    const key = JSON.stringify(players.map(p => [p.id, p.name, p.color, p.connected, p.bot, p.kills, p.deaths]
      .concat(p.id === state.hostId)));
    if (key === listSignature) return;
    listSignature = key;
    const rowTag = list => list.tagName === 'UL' || list.tagName === 'OL' ? 'li' : 'div';
    const playerRows = players.map(player => {
      const row = node(rowTag(ui['player-list']), 'tank-player-row');
      const flags = [];
      if (player.id === session.playerId) flags.push('你');
      if (player.id === state.hostId) flags.push('房主');
      if (player.bot) flags.push('电脑');
      if (!player.connected) flags.push('已掉线');
      if (!player.connected) row.classList.add('is-disconnected');
      row.append(colorDot(player), node('strong', 'tank-player-name', player.name));
      if (flags.length) row.append(node('small', 'player-meta', flags.join(' · ')));
      return row;
    });
    const scoreRows = [...players].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).map(player => {
      const row = node(rowTag(ui.scoreboard), 'tank-score-row');
      if (player.id === session.playerId) row.classList.add('is-self');
      row.append(colorDot(player), node('strong', 'tank-player-name', player.name),
        node('span', 'tank-score', player.kills + ' / ' + player.deaths));
      return row;
    });
    ui['player-list'].replaceChildren(...playerRows);
    ui.scoreboard.replaceChildren(...scoreRows);
  }

  function formatTimer(seconds) {
    const rounded = Math.max(0, Math.ceil(seconds || 0));
    return Math.floor(rounded / 60) + ':' + String(rounded % 60).padStart(2, '0');
  }

  function renderOverlay(me) {
    let title = '';
    let detail = '';
    if (state.phase === 'lobby') {
      if (state.mode === 'practice') {
        title = '准备练习';
        detail = '点击「开始对战」与电脑交手。';
      } else if (state.players.filter(player => player.connected).length < 2) {
        title = '等待对手';
        detail = '将房间码或链接发给好友，至少两人即可开战。';
      } else if (session.playerId === state.hostId) {
        title = '人员已到齐';
        detail = '点击「开始对战」，或再邀请好友加入。';
      } else {
        title = '等待房主开局';
        detail = '房主点击「开始对战」后，你会进入倒计时。';
      }
    } else if (state.phase === 'countdown') {
      title = Math.max(1, Math.ceil(state.countdown));
      detail = '准备开战';
    } else if (state.phase === 'finished') {
      const winner = state.players.find(player => player.id === state.winnerId);
      title = state.winnerId === session.playerId ? '你赢了！' : winner ? winner.name + ' 获胜' : '本局平局';
      detail = me ? me.kills + ' 击杀 · ' + me.deaths + ' 阵亡' : '本局已结束';
    } else if (me?.respawnIn > 0) {
      title = Math.ceil(me.respawnIn) + ' 秒后复活';
      detail = '复活后可继续对战。';
    }

    const signature = JSON.stringify([title, detail]);
    if (overlaySignature === signature) return;
    overlaySignature = signature;
    ui.overlay.hidden = !title;
    ui.overlay.replaceChildren();
    if (title) {
      const card = node('div', 'tank-overlay-card');
      card.append(node('h2', 'tank-overlay-title', title), node('p', 'tank-overlay-detail', detail));
      ui.overlay.append(card);
    }
  }

  function renderState() {
    if (!session || !state) return;
    ui.room.hidden = false;
    ui.lobby.hidden = true;
    ui.room.dataset.phase = state.phase;
    ui.stage.dataset.phase = state.phase;
    text(ui['room-code'], session.code);
    text(ui['map-name'], state.map?.name || '地图');
    text(ui.phase, phaseLabels[state.phase] || '房间');
    text(ui.timer, formatTimer(state.phase === 'lobby' || state.phase === 'countdown' ? 180 : state.remaining));
    const me = state.players.find(player => player.id === session.playerId);
    text(ui.health, Math.max(0, me?.hp ?? 0) + ' / 100');
    text(ui.weapon, me?.shield > 0
      ? (weaponLabels[me.weapon] || '普通炮弹') + ' · 护盾'
      : weaponLabels[me?.weapon] || '普通炮弹');
    text(ui.cooldown, me?.fireCooldown > 0.04 ? me.fireCooldown.toFixed(1) + ' 秒' : '可开火');
    const host = session.playerId === state.hostId;
    const joined = state.players.filter(player => player.connected).length;
    ui.start.hidden = !host || state.phase !== 'lobby';
    ui.start.disabled = operation || (state.mode !== 'practice' && joined < 2);
    ui.rematch.hidden = !host || state.phase !== 'finished';
    ui.rematch.disabled = operation || joined < 2;
    ui.leave.disabled = operation;
    renderPlayers();
    renderOverlay(me);
    renderControls();
    renderViewButton();
  }

  function setBusy(busy) {
    operation = busy;
    for (const button of [ui.create, ui.join, ui.practice]) button.disabled = busy || restoring;
    ui.name.disabled = busy || restoring;
    ui.code.disabled = busy || restoring;
    ui['map-select'].disabled = busy || restoring;
    for (const { button } of previews) button.disabled = busy || restoring;
    renderState();
  }

  function resetView(keepName = true) {
    if (immersive) exitFullscreen();
    clearTimeout(syncTimer);
    syncTimer = undefined;
    session = undefined;
    state = undefined;
    overview = false;
    restoring = false;
    flushAfterSync = false;
    syncFailures = 0;
    lastEvent = 0;
    lastSyncSent = 0;
    lastSentInput = false;
    feedbackUntil = 0;
    listSignature = '';
    overlaySignature = '';
    snapshots.length = 0;
    effects.length = 0;
    saveSession();
    releaseInputs(false);
    ui.lobby.hidden = false;
    ui.room.hidden = true;
    ui.overlay.hidden = true;
    text(ui.feedback, '');
    text(ui.connection, '');
    if (!keepName) ui.name.value = '';
    setBusy(false);
    requestAnimationFrame(resize);
  }

  function sound(type) {
    if (muted || !audio || audio.state !== 'running') return;
    const frequencies = { fire: 117, hit: 169, kill: 485, pickup: 636 };
    const frequency = frequencies[type];
    if (!frequency) return;
    const start = audio.currentTime;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = type === 'fire' || type === 'hit' ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * (type === 'fire' ? 0.52 : 1.28), start + 0.095);
    gain.gain.setValueAtTime(0.045, start);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.12);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.13);
  }

  function enableAudio() {
    if (muted) return;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return;
    try {
      audio ??= new Audio();
      if (audio.state === 'suspended') audio.resume().catch(() => {});
    } catch { /* Sound is optional. */ }
  }

  function showFeedback(message) {
    text(ui.feedback, message);
    feedbackUntil = performance.now() + 2200;
  }

  function processEvents(next, initial) {
    const currentEvents = next.events || [];
    if (initial) {
      lastEvent = currentEvents.reduce((latest, event) => Math.max(latest, event.id), 0);
      return;
    }
    const newEvents = currentEvents.filter(event => event.id > lastEvent);
    if (!newEvents.length) return;
    lastEvent = Math.max(...newEvents.map(event => event.id));
    const when = performance.now();
    effects.push(...newEvents.map(event => ({ ...event, when })));
    if (effects.length > 28) effects.splice(0, effects.length - 28);

    const local = next.players.find(player => player.id === session.playerId);
    const ownEvent = newEvents.slice().reverse().find(event => event.text && (
      event.playerId === session.playerId || (local && Math.hypot(event.x - local.x, event.y - local.y) < 42)
    ));
    if (ownEvent?.text) showFeedback(ownEvent.text);
    const effect = newEvents.some(event => event.type === 'pickup') ? 'pickup'
      : newEvents.some(event => event.type === 'kill') ? 'kill'
      : newEvents.some(event => event.type === 'hit') ? 'hit' : '';
    sound(effect);
  }

  function applyState(next) {
    if (!session || !next || !Array.isArray(next.players) || !next.map) return;
    if (state && next.tick < state.tick) return;
    const previous = state;
    if (previous && (next.phase !== previous.phase || next.mapId !== previous.mapId)) {
      snapshots.length = 0;
      if (next.phase !== 'playing') releaseInputs(false);
      else if (!document.hidden && !ui.help?.open) ui.canvas.focus({ preventScroll: true });
      if (next.phase === 'countdown') {
        overview = false;
        effects.length = 0;
        if ((next.events || []).every(event => event.id < lastEvent)) lastEvent = 0;
      }
    }
    state = next;
    const latest = snapshots.at(-1);
    if (!latest || latest.state.tick !== next.tick) snapshots.push({ state: next, time: performance.now() });
    else if (latest.state !== next) latest.state = next;
    if (snapshots.length > 5) snapshots.shift();
    processEvents(next, !previous);
    if (!controlsAllowed()) releaseInputs(false);
    renderState();
  }

  function interpolateAngle(from, to, ratio) {
    const turn = Math.PI * 2;
    const delta = ((to - from + Math.PI) % turn + turn) % turn - Math.PI;
    return from + delta * ratio;
  }

  function visualState(now) {
    if (state?.phase !== 'playing' || snapshots.length < 2) return state;
    const target = now - 65;
    let after = snapshots.findIndex(snapshot => snapshot.time > target);
    if (after < 0) return state;
    if (after === 0) return snapshots[0].state;
    const first = snapshots[after - 1];
    const second = snapshots[after];
    const ratio = Math.min(1, Math.max(0, (target - first.time) / (second.time - first.time)));
    const players = new Map(first.state.players.map(player => [player.id, player]));
    const bullets = new Map(first.state.bullets.map(bullet => [bullet.id, bullet]));
    return {
      ...second.state,
      players: second.state.players.map(player => {
        const old = players.get(player.id);
        if (!old || !old.hp || !player.hp || Math.hypot(player.x - old.x, player.y - old.y) > 85) return player;
        return {
          ...player,
          x: old.x + (player.x - old.x) * ratio,
          y: old.y + (player.y - old.y) * ratio,
          angle: interpolateAngle(old.angle, player.angle, ratio),
        };
      }),
      bullets: second.state.bullets.map(bullet => {
        const old = bullets.get(bullet.id);
        if (!old || old.bounces !== bullet.bounces || Math.hypot(bullet.x - old.x, bullet.y - old.y) > 110) return bullet;
        return { ...bullet, x: old.x + (bullet.x - old.x) * ratio, y: old.y + (bullet.y - old.y) * ratio };
      }),
    };
  }

  function renderFrame(now) {
    if (renderer && state && !ui.room.hidden) {
      if (effects.length && now - effects[0].when >= 650) {
        const activeEffects = effects.filter(effect => now - effect.when < 650);
        effects.splice(0, effects.length, ...activeEffects);
      }
      renderer.draw(visualState(now), {
        playerId: session?.playerId,
        overview,
        time: now,
        effects: effects.map(effect => ({ ...effect, age: (now - effect.when) / 650 })),
      });
    }
    if (feedbackUntil && now > feedbackUntil) {
      feedbackUntil = 0;
      text(ui.feedback, '');
    }
    requestAnimationFrame(renderFrame);
  }

  function nextInput(current = session, neutral = false) {
    current.seq += 1;
    saveSession();
    const payload = { ...actionPayload(current), seq: current.seq };
    const steering = joystickActions();
    for (const action of actions) payload[action] = !neutral && (active(action) || Boolean(steering[action]) || (action === 'fire' && fireTaps > 0));
    return payload;
  }

  function queueSync(delay = syncInterval) {
    if (!session) return;
    clearTimeout(syncTimer);
    if (syncing) {
      flushAfterSync = true;
      return;
    }
    syncTimer = setTimeout(sync, Math.max(0, delay));
  }

  async function sync() {
    if (!session || syncing) return;
    const current = session;
    const now = performance.now();
    const hadTap = fireTaps > 0;
    const payload = nextInput(current, !controlsAllowed());
    fireTaps = 0;
    lastSyncSent = now;
    lastSentInput = actions.some(action => payload[action]);
    syncing = true;
    flushAfterSync = false;
    try {
      const { state: next } = await request('/api/tanks/sync', payload);
      if (current !== session) return;
      const resumed = syncFailures > 0;
      syncFailures = 0;
      if (restoring) {
        restoring = false;
        setBusy(false);
        text(ui.status, '');
        requestAnimationFrame(resize);
      }
      const previousShot = state?.players.find(player => player.id === current.playerId)?.fireCooldown || 0;
      const nextShot = next?.players.find(player => player.id === current.playerId)?.fireCooldown || 0;
      if (payload.fire && nextShot > previousShot + .3) sound('fire');
      applyState(next);
      if (resumed) setInvite();
      text(ui.connection, '连接正常');
      if (resumed) showFeedback('连接已恢复');
    } catch (error) {
      if (current !== session) return;
      if ([401, 404, 410].includes(error.status)) {
        resetView();
        text(ui.status, '房间已结束或会话已失效，请重新创建或加入。');
        return;
      }
      syncFailures += 1;
      const label = '连接中断，正在重连…';
      if (restoring) text(ui.status, label);
      else text(ui.connection, label);
      if (hadTap || pressedKeys.size || pressedPointers.size || joystick.strength) releaseInputs(false);
      renderControls();
    } finally {
      syncing = false;
      if (session) {
        const elapsed = performance.now() - lastSyncSent;
        const delay = syncFailures ? Math.min(1800, 250 * 2 ** Math.min(syncFailures - 1, 3))
          : flushAfterSync ? 0 : syncInterval - elapsed;
        queueSync(delay);
      }
    }
  }

  function validName() {
    const name = ui.name.value.trim();
    if (!name) {
      text(ui.status, '请先输入昵称。');
      ui.name.focus();
      return '';
    }
    if (Array.from(name).length > 16) {
      text(ui.status, '昵称最多 16 个字符。');
      ui.name.focus();
      return '';
    }
    return name;
  }

  function validCode() {
    const code = ui.code.value.trim();
    if (!roomCode.test(code)) {
      text(ui.status, '请输入六位数字房间码。');
      ui.code.focus();
      return '';
    }
    return code;
  }

  function activate(data) {
    const { code, token, playerId } = data;
    if (!roomCode.test(code) || typeof token !== 'string' || typeof playerId !== 'string' || !data.state) {
      throw new Error('无效房间响应');
    }
    clearTimeout(syncTimer);
    session = { code, token, playerId, seq: 0 };
    state = undefined;
    overview = false;
    lastEvent = 0;
    syncFailures = 0;
    snapshots.length = 0;
    effects.length = 0;
    listSignature = '';
    overlaySignature = '';
    saveSession();
    applyState(data.state);
    setInvite();
    text(ui.status, '');
    text(ui.connection, '连接正常');
    resize();
    requestAnimationFrame(resize);
    queueSync(0);
  }

  async function enterRoom(kind) {
    if (operation || restoring || session) return;
    const name = validName();
    if (!name) return;
    const code = kind === 'join' && validCode();
    if (kind === 'join' && !code) return;
    enableAudio();
    setBusy(true);
    text(ui.status, kind === 'join' ? '正在加入房间…' : '正在创建房间…');
    try {
      const payload = kind === 'join' ? { code, name }
        : { name, mapId: ui['map-select'].value || 'random', practice: kind === 'practice' };
      const data = await request('/api/tanks/' + (kind === 'join' ? 'join' : 'create'), payload);
      writeStorage(() => localStorage, nicknameKey, name);
      activate(data);
    } catch (error) {
      text(ui.status, messageFor(error));
    } finally {
      setBusy(false);
    }
  }

  async function roomAction(action) {
    if (!session || operation) return;
    const current = session;
    setBusy(true);
    try {
      const result = await request('/api/tanks/' + action, actionPayload(current));
      if (current !== session) return;
      if (action === 'leave') {
        const leftCode = session.code;
        resetView();
        ui.code.value = leftCode;
        text(ui.status, '已退出房间。');
      } else {
        applyState(result.state);
      }
    } catch (error) {
      if (current !== session) return;
      if (action === 'leave' && [401, 404, 410].includes(error.status)) {
        resetView();
        text(ui.status, '房间已结束。');
      } else showFeedback(messageFor(error));
    } finally {
      if (current === session) setBusy(false);
    }
  }

  function inviteUrl(code) {
    const suggested = config.shareUrls?.[0];
    let base = new URL('/games/tanks/play', window.location.href);
    if (suggested) {
      try {
        const candidate = new URL(suggested, base);
        if (candidate.protocol === 'http:' || candidate.protocol === 'https:') base = candidate;
      } catch { /* Current address is sufficient for same-device play. */ }
    }
    base.search = '';
    base.hash = '';
    base.searchParams.set('room', code);
    return base.href;
  }

  function setInvite() {
    if (!session) return;
    const practice = state?.mode === 'practice';
    ui['copy-invite'].hidden = practice;
    ui['invite-text'].hidden = practice;
    const noteTarget = ui['room-share-note'] || ui['share-note'];
    if (practice) {
      text(noteTarget, '练习房间由电脑担任对手。');
      return;
    }
    ui['invite-text'].value = inviteUrl(session.code);
    const loopback = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(ui['invite-text'].value).hostname);
    const note = loopback
      ? '此地址只能在这台电脑打开。两人可用独立浏览器进入同一房间。'
      : config.scope === 'public' ? '把邀请链接发给好友即可加入。' : '同一 Wi-Fi 或局域网内的好友可打开此链接。';
    text(noteTarget, note);
  }

  async function copyInvite() {
    if (!session) return;
    const value = ui['invite-text'].value;
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      await navigator.clipboard.writeText(value);
    } catch {
      ui['invite-text'].focus();
      ui['invite-text'].select();
      if (!document.execCommand?.('copy')) {
        showFeedback('链接已选中，可以直接复制。');
        return;
      }
      ui['copy-invite'].focus();
    }
    showFeedback('邀请链接已复制');
  }

  function renderMapSelection() {
    const selected = ui['map-select'].value;
    for (const { button } of previews) {
      const activeMap = button.dataset.mapId === selected;
      button.classList.toggle('is-active', activeMap);
      button.setAttribute('aria-pressed', String(activeMap));
    }
  }

  function buildMapCards() {
    for (const preview of previews) preview.renderer?.destroy?.();
    previews.length = 0;
    const select = ui['map-select'];
    select.replaceChildren(new Option('随机地图', 'random'));
    ui['map-grid'].replaceChildren();

    for (const map of maps) {
      select.append(new Option(map.name, map.id));
      const button = node('button', 'tank-map-card');
      button.type = 'button';
      button.dataset.mapId = map.id;
      button.dataset.season = map.season;
      let preview;
      if (window.createTankRenderer) {
        const canvas = node('canvas', 'tank-map-thumb');
        canvas.setAttribute('aria-hidden', 'true');
        button.append(canvas);
        preview = window.createTankRenderer(canvas);
      }
      const copy = node('span', 'tank-map-card-copy');
      copy.append(node('strong', 'tank-map-card-name', map.name));
      if (map.subtitle) copy.append(node('small', 'tank-map-card-subtitle', map.subtitle));
      button.append(copy);
      button.addEventListener('click', () => {
        select.value = map.id;
        renderMapSelection();
      });
      ui['map-grid'].append(button);
      previews.push({ map, button, renderer: preview });
    }
    setBusy(operation);
    renderMapSelection();
    requestAnimationFrame(resizeMaps);
  }

  function resizeMaps() {
    if (ui.lobby.hidden) return;
    for (const preview of previews) {
      if (!preview.renderer) continue;
      preview.renderer.resize();
      preview.renderer.draw({ map: preview.map }, { preview: true, time: 0 });
    }
  }

  function resize() {
    if (renderer && !ui.room.hidden) renderer.resize();
    resizeMaps();
  }

  function emergencyRelease() {
    if (!session || !state || state.phase !== 'playing') return;
    const hadInput = pressedKeys.size || pressedPointers.size || fireTaps || joystick.strength || lastSentInput;
    releaseInputs(false);
    if (!hadInput) return;
    lastSentInput = false;
    // A new sequence prevents an older in-flight packet from restoring held keys.
    request('/api/tanks/sync', nextInput(session, true), { keepalive: true }).catch(() => {});
  }

  ui.create.addEventListener('click', event => { event.preventDefault(); enterRoom('create'); });
  ui.join.addEventListener('click', event => { event.preventDefault(); enterRoom('join'); });
  ui.practice.addEventListener('click', event => { event.preventDefault(); enterRoom('practice'); });
  const form = ui.lobby.matches('form') ? ui.lobby : ui.lobby.querySelector('form');
  form?.addEventListener('submit', event => {
    event.preventDefault();
    enterRoom(roomCode.test(ui.code.value.trim()) ? 'join' : 'create');
  });
  if (!form) {
    ui.name.addEventListener('keydown', event => {
      if (event.key === 'Enter') enterRoom(roomCode.test(ui.code.value.trim()) ? 'join' : 'create');
    });
    ui.code.addEventListener('keydown', event => {
      if (event.key === 'Enter') enterRoom('join');
    });
  }
  ui.start.addEventListener('click', () => { enableAudio(); roomAction('start'); });
  ui.rematch.addEventListener('click', () => { enableAudio(); roomAction('rematch'); });
  ui.leave.addEventListener('click', () => { releaseInputs(); roomAction('leave'); });
  ui['copy-invite'].addEventListener('click', copyInvite);
  ui['map-select'].addEventListener('change', renderMapSelection);
  ui['view-toggle']?.addEventListener('click', toggleOverview);
  ui.fullscreen?.addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => setImmersive(document.fullscreenElement === ui.arena));
  ui.code.addEventListener('input', () => { ui.code.value = ui.code.value.replace(/\D/g, '').slice(0, 6); });
  ui['help-toggle']?.addEventListener('click', () => { releaseInputs(); ui.help?.showModal(); });
  ui['help-close']?.addEventListener('click', () => ui.help?.close());
  ui.help?.addEventListener('close', renderControls);
  ui.sound?.addEventListener('click', () => {
    muted = !muted;
    ui.sound.setAttribute('aria-pressed', String(!muted));
    text(ui.sound, muted ? '声音关闭' : '声音开启');
    if (!muted) {
      enableAudio();
      sound('pickup');
    }
  });

  window.addEventListener('keydown', event => {
    const key = event.key.toLowerCase();
    if (key === 'escape' && immersive) { event.preventDefault(); exitFullscreen(); return; }
    if (key === 'm' && session && state?.phase === 'playing' && !document.hidden && !ui.help?.open &&
        !editable(event.target) && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (!event.repeat) toggleOverview();
      return;
    }
    const action = keyActions.get(key);
    if (!action || !controlsAllowed() || editable(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
    if (action === 'fire' && event.target instanceof Element && event.target.closest('button,a')) return;
    event.preventDefault();
    if (event.repeat || pressedKeys.has(key)) return;
    enableAudio();
    pressedKeys.set(key, action);
    if (action === 'fire') fireTaps = 1;
    renderControls();
    queueSync(0);
  });
  window.addEventListener('keyup', event => {
    if (pressedKeys.delete(event.key.toLowerCase())) {
      event.preventDefault();
      renderControls();
      queueSync(0);
    }
  });

  for (const button of inputButtons) {
    button.addEventListener('pointerdown', event => {
      if (!controlsAllowed() || event.button !== 0) return;
      event.preventDefault();
      enableAudio();
      pressedPointers.set(event.pointerId, button.dataset.tankControl);
      if (button.dataset.tankControl === 'fire') fireTaps = 1;
      button.setPointerCapture?.(event.pointerId);
      renderControls();
      queueSync(0);
    });
    const releasePointer = event => {
      if (!pressedPointers.delete(event.pointerId)) return;
      renderControls();
      queueSync(0);
    };
    button.addEventListener('pointerup', releasePointer);
    button.addEventListener('pointercancel', releasePointer);
    button.addEventListener('lostpointercapture', releasePointer);
    button.addEventListener('click', event => {
      if (event.detail !== 0 || !controlsAllowed()) return;
      if (button.dataset.tankControl === 'fire') {
        enableAudio();
        fireTaps = 1;
        queueSync(0);
      }
    });
  }

  function moveJoystick(event) {
    if (event.pointerId !== joystick.pointerId || !controlsAllowed()) return;
    event.preventDefault();
    const bounds = joystick.bounds;
    const limit = Math.min(bounds.width, bounds.height) * .30;
    const dx = event.clientX - bounds.left - bounds.width / 2;
    const dy = event.clientY - bounds.top - bounds.height / 2;
    const distance = Math.hypot(dx, dy);
    const ratio = distance > limit ? limit / distance : 1;
    joystick.x = dx * ratio;
    joystick.y = dy * ratio;
    joystick.strength = Math.min(1, distance / limit);
    if (ui['joystick-knob']) ui['joystick-knob'].style.transform = `translate(calc(-50% + ${joystick.x}px), calc(-50% + ${joystick.y}px))`;
    ui.joystick.classList.toggle('is-active', joystick.strength >= .18);
    queueSync(0);
  }

  ui.joystick?.addEventListener('pointerdown', event => {
    if (!controlsAllowed() || event.button !== 0 || joystick.pointerId !== null) return;
    event.preventDefault();
    joystick.pointerId = event.pointerId;
    joystick.bounds = ui.joystick.getBoundingClientRect();
    ui.joystick.setPointerCapture?.(event.pointerId);
    moveJoystick(event);
  });
  ui.joystick?.addEventListener('pointermove', moveJoystick);
  for (const eventType of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    ui.joystick?.addEventListener(eventType, event => {
      if (event.pointerId !== joystick.pointerId) return;
      event.preventDefault();
      resetJoystick();
      queueSync(0);
    });
  }

  window.addEventListener('blur', emergencyRelease);
  window.addEventListener('pagehide', emergencyRelease);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) emergencyRelease();
    else if (session) queueSync(0);
  });
  window.addEventListener('online', () => { if (session) queueSync(0); });
  window.addEventListener('resize', () => { emergencyRelease(); resize(); });
  if (window.ResizeObserver && ui.stage) new ResizeObserver(resize).observe(ui.stage);

  renderer = window.createTankRenderer?.(ui.canvas);
  requestAnimationFrame(renderFrame);
  const invited = new URLSearchParams(window.location.search).get('room');
  if (roomCode.test(invited || '')) ui.code.value = invited;
  const savedName = readStorage(() => localStorage, nicknameKey);
  if (savedName) ui.name.value = savedName;

  const stored = getSession();
  if (stored && (!invited || invited === stored.code || !roomCode.test(invited))) {
    session = stored;
    restoring = true;
    setBusy(false);
    text(ui.status, '正在恢复房间…');
    ui.code.value = session.code;
    queueSync(0);
  } else if (stored) {
    saveSession();
  }

  request('/api/tanks/config').then(result => {
    config = result;
    if (!session) {
      const label = config.scope === 'public' ? '可跨网络联机'
        : config.scope === 'lan' ? '局域网可联机' : '本地服务已连接';
      text(ui.connection, label);
    }
    setInvite();
  }).catch(() => {
    if (!session) text(ui.connection, '服务未连接');
  });
  request('/tank-maps.json', undefined, { timeout: 5000 }).then(data => {
    if (Array.isArray(data)) {
      maps = data;
      buildMapCards();
    }
  }).catch(() => {
    if (!session) text(ui.status, '地图预览暂时无法加载，仍可使用随机地图。');
  });
})();
