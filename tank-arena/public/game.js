'use strict';

const title = document.getElementById('game-title');
const description = document.getElementById('game-description');
const start = document.getElementById('start-game');
const status = document.getElementById('game-status');
const slug = location.pathname.split('/').filter(Boolean)[1];

async function loadGame() {
  try {
    let game = examples.find(example => example.id === slug);
    if (!game) {
      const response = await fetch('/api/projects/' + encodeURIComponent(slug || ''));
      if (response.status === 404) throw new Error('这款游戏暂未收录或已下架。');
      if (!response.ok) throw new Error('游戏介绍暂时无法加载，请刷新后重试。');
      ({ project: game } = await response.json());
    }

    document.title = game.title + ' · 像素工坊';
    title.textContent = game.title;
    if (game.description) {
      description.textContent = game.description;
      description.hidden = false;
    }
    start.href = game.playUrl || game.url;
    if (!game.playUrl) {
      start.target = '_blank';
      start.rel = 'noopener noreferrer';
    }
    start.hidden = false;
    if (game.instructions?.length) {
      const items = game.instructions.map(line => {
        const item = document.createElement('li');
        item.textContent = line;
        return item;
      });
      document.getElementById('instructions-list').append(...items);
      document.getElementById('game-instructions').hidden = false;
    }
    status.hidden = true;
  } catch (error) {
    title.textContent = '游戏介绍';
    status.textContent = error instanceof TypeError ? '游戏介绍暂时无法加载，请刷新后重试。' : error.message;
  }
}

loadGame();
