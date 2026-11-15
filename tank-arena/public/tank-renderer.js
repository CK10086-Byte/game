(() => {
  "use strict";

  const THEMES = {
    classic: { paper: "#f3eedf", edge: "#e3dac7", grain: "#806a4d", ink: "#39433d", trim: "#a5ad8f" },
    spring: { paper: "#f9ece6", edge: "#e9cfc8", grain: "#b36677", ink: "#475847", trim: "#e398ae" },
    summer: { paper: "#faf0d8", edge: "#ead7ad", grain: "#ae894b", ink: "#2c7182", trim: "#67bfcb" },
    autumn: { paper: "#f9e9d5", edge: "#e9cdaa", grain: "#ad6e40", ink: "#6e4935", trim: "#d98540" },
    winter: { paper: "#edf4f4", edge: "#d4e3e8", grain: "#6e9aaa", ink: "#526c7e", trim: "#92bbce" },
  };

  const MATERIALS = {
    wall: { dark: "#293732", light: "#56645a", bottom: "#1e2925", detail: "#aeb399" },
    hedge: { dark: "#425b42", light: "#7f9761", bottom: "#304632", detail: "#f1a9bd" },
    water: { dark: "#3e8fa2", light: "#80d4dc", bottom: "#326977", detail: "#caf8ed" },
    sand: { dark: "#a67643", light: "#e9bf83", bottom: "#865e39", detail: "#ffdea5" },
    log: { dark: "#7b5137", light: "#bc8556", bottom: "#604233", detail: "#e5b572" },
    ice: { dark: "#688ca0", light: "#ccf0f5", bottom: "#547385", detail: "#f6ffff" },
  };

  const PICKUP_COLORS = {
    heal: ["#d96a62", "#fff7ed"],
    double: ["#dca249", "#fff6da"],
    heavy: ["#9b74b9", "#fcf2ff"],
    shield: ["#59a8b1", "#ebfcff"],
  };
  const PREVIEW_COLORS = ["#de6b53", "#518cbd", "#b29945", "#79a86a"];
  const TAU = Math.PI * 2;

  function rounded(context, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    context.beginPath();
    context.moveTo(x + radius, y);
    context.arcTo(x + w, y, x + w, y + h, radius);
    context.arcTo(x + w, y + h, x, y + h, radius);
    context.arcTo(x, y + h, x, y, radius);
    context.arcTo(x, y, x + w, y, radius);
    context.closePath();
  }

  function rect(context, x, y, w, h, r, color) {
    rounded(context, x, y, w, h, r);
    context.fillStyle = color;
    context.fill();
  }

  function dot(context, x, y, radius, color) {
    context.beginPath();
    context.arc(x, y, radius, 0, TAU);
    context.fillStyle = color;
    context.fill();
  }

  function line(context, points, color, width) {
    context.beginPath();
    context.moveTo(points[0], points[1]);
    for (let index = 2; index < points.length; index += 2) {
      context.lineTo(points[index], points[index + 1]);
    }
    context.strokeStyle = color;
    context.lineWidth = width;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.stroke();
  }

  function gradient(context, x, y, endX, endY, start, end) {
    const fill = context.createLinearGradient(x, y, endX, endY);
    fill.addColorStop(0, start);
    fill.addColorStop(1, end);
    return fill;
  }

  function randomSource(seed) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function blossom(context, x, y, size, rotation) {
    for (let index = 0; index < 5; index++) {
      const angle = rotation + index * TAU / 5;
      dot(context, x + Math.cos(angle) * size * .46, y + Math.sin(angle) * size * .46, size * .39, "#f7b9cb");
    }
    dot(context, x, y, size * .31, "#c46c8b");
    dot(context, x - size * .09, y - size * .08, size * .12, "#fff2e7");
  }

  function leaf(context, x, y, size, rotation, color) {
    context.save();
    context.translate(x, y);
    context.rotate(rotation);
    context.beginPath();
    context.moveTo(-size, 0);
    context.quadraticCurveTo(0, -size * .74, size, 0);
    context.quadraticCurveTo(0, size * .74, -size, 0);
    context.fillStyle = color;
    context.fill();
    line(context, [-size * .64, 0, size * .59, 0], "#8b654054", .9);
    context.restore();
  }

  function crystal(context, x, y, size, color) {
    for (let index = 0; index < 3; index++) {
      const angle = index * Math.PI / 3;
      const dx = Math.cos(angle) * size;
      const dy = Math.sin(angle) * size;
      line(context, [x - dx, y - dy, x + dx, y + dy], color, 1.8);
    }
    dot(context, x, y, size * .17, color);
  }

  function drawWall(context, wall, random) {
    const { x, y, w, h, kind } = wall;
    const material = MATERIALS[kind] || MATERIALS.wall;
    const vertical = h > w;
    const radius = kind === "water" ? 12 : 7;
    rect(context, x + 2, y + 5, w, h, radius + 1, "#30372c25");
    rect(context, x, y, w, h, radius, material.bottom);
    rect(context, x + 2, y + 2, w - 4, h - 5, radius - 1,
      gradient(context, x, y, x + (vertical ? w : 1), y + (vertical ? 1 : h), material.light, material.dark));

    context.save();
    rounded(context, x + 2, y + 2, w - 4, h - 5, radius - 1);
    context.clip();
    if (kind === "water") {
      rounded(context, x + 6, y + 6, w - 12, h - 14, radius - 2);
      context.strokeStyle = "#bbefd9bd";
      context.lineWidth = 2;
      context.stroke();
      for (let r = 13; r < h - 7; r += 15) {
        for (let c = 12; c < w - 9; c += 30) {
          if (random() < .23) continue;
          const xx = x + c + random() * 9;
          const yy = y + r + random() * 5;
          context.beginPath();
          context.moveTo(xx, yy);
          context.quadraticCurveTo(xx + 7, yy - 4, xx + 14, yy);
          context.strokeStyle = random() < .5 ? "#dbfff09d" : "#327c9876";
          context.lineWidth = 2;
          context.stroke();
        }
      }
    } else if (kind === "hedge") {
      for (let r = 7; r < h; r += 11) {
        for (let c = 8; c < w; c += 12) {
          const xx = x + c + (random() - .5) * 5;
          const yy = y + r + (random() - .5) * 6;
          dot(context, xx, yy, 4 + random() * 3, random() < .55 ? "#9eac6a8a" : "#36554266");
          if (random() < .38) blossom(context, xx, yy, 3.5 + random() * 3.8, random() * TAU);
        }
      }
    } else if (kind === "ice") {
      for (let index = 10; index < (vertical ? h : w); index += 18) {
        const xx = x + (vertical ? 11 + random() * Math.max(1, w - 24) : index);
        const yy = y + (vertical ? index : 9 + random() * Math.max(1, h - 24));
        crystal(context, xx, yy, 3 + random() * 6, random() < .4 ? "#fff" : "#e2fbffc9");
        line(context, [xx - 9, yy + 10, xx + 11, yy - 10], "#f5ffffff30", 2);
      }
    } else if (kind === "log") {
      for (let offset = 7; offset < Math.min(w, h); offset += 8) {
        const coords = vertical
          ? [x + offset, y + 4, x + offset - 2, y + h * .42, x + offset + 2, y + h - 7]
          : [x + 4, y + offset, x + w * .4, y + offset - 2, x + w - 4, y + offset + 2];
        line(context, coords, random() < .5 ? "#55362367" : "#ebbf857e", 1.4);
      }
      const ends = vertical ? [[x + w * .5, y + 14], [x + w * .5, y + h - 16]]
        : [[x + 14, y + h * .48], [x + w - 16, y + h * .48]];
      for (const [ex, ey] of ends) {
        dot(context, ex, ey, 10, "#e7b678bd");
        dot(context, ex, ey, 7, "#855940c9");
        dot(context, ex, ey, 4, "#d29c65");
      }
    } else {
      for (let i = 20; i < (vertical ? h : w) - 9; i += 33) {
        const xx = x + (vertical ? w * .28 : i);
        const yy = y + (vertical ? i : h * .30);
        if (kind === "sand") {
          dot(context, xx, yy, 3.4, material.detail);
          dot(context, xx + 7, yy + 7, 2.7, "#976a4578");
        } else {
          line(context, [xx, yy, xx + (vertical ? 8 : 13), yy + (vertical ? 12 : 0)], "#cad4b63f", 1.4);
        }
      }
    }
    context.restore();
    if (kind !== "water") line(context, [x + 8, y + 4, x + w - 8, y + 4], kind === "ice" ? "#ffffffbc" : "#ffefd163", 1.5);
  }

  function drawMap(context, map) {
    const { width, height } = map;
    const theme = THEMES[map.season] || THEMES.classic;
    const random = randomSource([...map.id].reduce((sum, character) => Math.imul(sum, 33) + character.charCodeAt(0), 1200));
    context.fillStyle = gradient(context, 0, 0, width, height, "#fffaf0", theme.paper);
    context.fillRect(0, 0, width, height);
    context.fillStyle = theme.paper;
    context.globalAlpha = .53;
    context.fillRect(0, 0, width, height);
    context.globalAlpha = .11;
    for (let index = 0; index < 3200; index++) {
      const x = random() * width;
      const y = random() * height;
      context.fillStyle = random() < .36 ? theme.grain : "#fffefa";
      context.fillRect(x, y, 1 + random() * 2.9, .7 + random() * 1.3);
    }
    context.globalAlpha = 1;

    rounded(context, 10, 10, width - 20, height - 20, 18);
    context.strokeStyle = theme.edge;
    context.lineWidth = 16;
    context.stroke();
    rounded(context, 20, 20, width - 40, height - 40, 12);
    context.strokeStyle = "#ffffffbc";
    context.lineWidth = 2;
    context.stroke();

    for (let x = 68; x < width - 42; x += 62) {
      const offset = random() * 17;
      line(context, [x, 27, x + 12, 27], theme.edge, 2);
      line(context, [x + offset, height - 27, x + offset + 12, height - 27], theme.edge, 2);
    }
    for (let y = 62; y < height - 36; y += 61) {
      line(context, [26, y, 26, y + 10], theme.edge, 2);
      line(context, [width - 26, y + 7, width - 26, y + 17], theme.edge, 2);
    }

    for (const spawn of map.spawns || []) {
      context.beginPath();
      context.arc(spawn.x, spawn.y, 27, 0, TAU);
      context.strokeStyle = theme.edge;
      context.lineWidth = 1.5;
      context.setLineDash([4, 5]);
      context.stroke();
      context.setLineDash([]);
      dot(context, spawn.x, spawn.y, 2.8, theme.edge);
    }

    for (let index = 0; index < 60; index++) {
      const horizontal = index % 2 === 0;
      const inset = 39 + random() * 11;
      const cross = 60 + random() * ((horizontal ? width : height) - 120);
      const farSide = index % 4 > 1;
      const x = horizontal ? cross : farSide ? width - inset : inset;
      const y = horizontal ? farSide ? height - inset : inset : cross;
      if (map.season === "spring") blossom(context, x, y, 3.1 + random() * 3.6, random() * TAU);
      else if (map.season === "summer") dot(context, x, y, 1.9 + random() * 2.7, random() < .5 ? "#d7b991" : "#9bc3b6");
      else if (map.season === "autumn") leaf(context, x, y, 3 + random() * 4, random() * TAU, random() < .5 ? "#dc975e" : "#b77252");
      else if (map.season === "winter") crystal(context, x, y, 2.4 + random() * 4.1, "#91b5c6ad");
      else if (index % 3 === 0) dot(context, x, y, 1.6 + random() * 2, "#b8b79796");
    }
    for (const wall of map.walls || []) drawWall(context, wall, random);
  }

  function drawTank(context, player, selected, preview, labelScale = 1) {
    if (player.hp <= 0 || player.respawnIn > 0) return;
    const tint = player.color || PREVIEW_COLORS[0];
    context.save();
    context.translate(player.x, player.y);
    if (player.connected === false) context.globalAlpha = .52;

    if (selected && !preview) {
      context.beginPath();
      context.ellipse(0, 0, 26.5, 25, 0, 0, TAU);
      context.lineWidth = 2;
      context.strokeStyle = tint;
      context.stroke();
      context.beginPath();
      context.ellipse(0, 0, 28.5, 27, 0, 0, TAU);
      context.lineWidth = 1;
      context.strokeStyle = "#ffffffe0";
      context.stroke();
    }
    if (player.shield > 0 && !preview) {
      context.beginPath();
      context.arc(0, 0, 23, 0, TAU);
      context.fillStyle = "#81dbf04a";
      context.fill();
      context.lineWidth = 2.5;
      context.strokeStyle = "#66c9d9";
      context.stroke();
    }

    context.save();
    context.rotate(player.angle || 0);
    rect(context, -17, -15, 37, 37, 8, "#2831263c");
    for (const y of [-17, 9]) {
      rect(context, -17, y, 33, 9, 3, "#252e2d");
      for (let x = -13; x < 15; x += 5) line(context, [x, y + 2, x, y + 7], "#6c796c", 1.4);
    }
    rect(context, -15, -11, 30, 24, 5, "#263c35");
    rect(context, -14, -11, 28, 21, 4.5, tint);
    rect(context, -12, -10, 24, 7, 3, "#ffffff29");
    rect(context, -13, 7, 25, 3, 1.4, "#1a29293e");
    rect(context, -13, -4, 5, 8, 1.4, "#263c354f");
    if (player.weapon === "double") {
      for (const y of [-5.5, 2]) rect(context, 1, y, 21, 4.5, 1.4, "#283831");
    } else {
      const heavy = player.weapon === "heavy";
      rect(context, 0, heavy ? -5 : -3.5, 23, heavy ? 10 : 7, 2.2, "#243b32");
      rect(context, 9, heavy ? -4 : -2.4, 11, heavy ? 3 : 1.9, .9, "#dde4cb5e");
      rect(context, 20, heavy ? -5.5 : -4, 3.6, heavy ? 11 : 8, 1.3, "#1b2d27");
    }
    dot(context, -1.5, 0, 8.7, "#334a3d");
    dot(context, -1.8, -.7, 7.1, tint);
    dot(context, -3.2, -2.2, 3.7, "#ffffff49");
    context.restore();

    if (!preview) {
      const labelY = player.y < 25 + 33 * labelScale ? 24 + 30 * labelScale : -24;
      context.translate(0, labelY);
      context.scale(labelScale, labelScale);
      rect(context, -19, -13, 38, 5.7, 3, "#253831ab");
      const hpWidth = 36 * Math.max(0, Math.min(1, player.hp / 100));
      if (hpWidth > 0) rect(context, -18, -12.2, hpWidth, 4, 2, player.hp < 36 ? "#e66c63" : "#83bb82");
      const name = String(player.name || "");
      context.font = "700 13px system-ui, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.lineWidth = 3.5;
      context.strokeStyle = "#fffffff0";
      context.lineJoin = "round";
      context.strokeText(name, 0, -23, 94);
      context.fillStyle = "#253832";
      context.fillText(name, 0, -23, 94);
    }
    context.restore();
  }

  function drawPickup(context, item, phase) {
    const [color, icon] = PICKUP_COLORS[item.type] || PICKUP_COLORS.heal;
    const y = item.y + Math.sin(phase * 1.8 + item.x * .04) * 1.8;
    context.save();
    context.translate(item.x, y);
    dot(context, 0, 0, 18, color + "31");
    rect(context, -11, -9, 24, 23, 6, "#2636313a");
    rect(context, -12, -12, 24, 23, 5, "#344340");
    rect(context, -10.5, -11, 21, 20.5, 4, color);
    line(context, [-6.5, -8, 6.5, -8], "#ffffff7a", 1.4);
    if (item.type === "heal") {
      rect(context, -2, -6.7, 4, 13, 1, icon);
      rect(context, -6.6, -2.1, 13.2, 4, 1, icon);
    } else if (item.type === "double") {
      line(context, [-4, 6, -4, -6], icon, 2.7);
      line(context, [4, 6, 4, -6], icon, 2.7);
      line(context, [-6, -3, -4, -6, -2, -3], icon, 1.4);
      line(context, [2, -3, 4, -6, 6, -3], icon, 1.4);
    } else if (item.type === "heavy") {
      dot(context, -1.2, 2, 4.9, icon);
      line(context, [1, -1.5, 3, -4.9, 6.6, -5.8], icon, 2.4);
    } else if (item.type === "shield") {
      context.beginPath();
      context.moveTo(0, -6.8);
      context.lineTo(6, -4.3);
      context.quadraticCurveTo(5.9, 3.9, 0, 6.7);
      context.quadraticCurveTo(-5.9, 3.9, -6, -4.3);
      context.closePath();
      context.strokeStyle = icon;
      context.lineWidth = 2.3;
      context.stroke();
    }
    context.restore();
  }

  function drawBullet(context, bullet, map) {
    const tint = bullet.kind === "heavy" ? "#a967af" : bullet.kind === "double" ? "#d59542" : "#506257";
    const radius = bullet.kind === "heavy" ? 5 : 3.5;
    const magnitude = Math.hypot(bullet.vx, bullet.vy) || 1;
    const dx = bullet.vx / magnitude;
    const dy = bullet.vy / magnitude;
    let trail = bullet.kind === "heavy" ? 25 : 17;
    // Sample backward so a reflected projectile's tail stays on the open side of the wall.
    for (let offset = 3; offset <= trail; offset += 3) {
      const x = bullet.x - dx * offset;
      const y = bullet.y - dy * offset;
      if (x < 0 || y < 0 || x > map.width || y > map.height ||
          map.walls.some(wall => x >= wall.x && x <= wall.x + wall.w && y >= wall.y && y <= wall.y + wall.h)) {
        trail = offset - 3;
        break;
      }
    }
    const fromX = bullet.x - dx * trail;
    const fromY = bullet.y - dy * trail;
    if (trail > 0) {
      const fill = gradient(context, fromX, fromY, bullet.x, bullet.y, tint + "00", tint + "c0");
      line(context, [fromX, fromY, bullet.x, bullet.y], fill, radius + 1);
    }
    dot(context, bullet.x, bullet.y, radius, tint);
    dot(context, bullet.x + dx, bullet.y + dy, radius * .56, "#fff0c8");
  }

  function drawEffect(context, effect) {
    const age = Number(effect.age);
    if (!Number.isFinite(age) || age < 0 || age >= 1) return;
    const { x, y, type } = effect;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const palette = {
      bounce: ["#c78b48", "#f7e8ba", 6, 19],
      hit: ["#de6c57", "#fff0b4", 8, 25],
      kill: ["#b75046", "#f3a968", 12, 46],
      pickup: ["#5d9e74", "#f0f6bd", 7, 31],
    };
    const [base, spark, count, extent] = palette[type] || palette.hit;
    const expansion = 1 - (1 - age) ** 3;
    context.save();
    context.globalAlpha = (1 - age) * .9;
    context.beginPath();
    context.arc(x, y, 4 + extent * expansion, 0, TAU);
    context.strokeStyle = base;
    context.lineWidth = 1.2 + (1 - age) * 2.1;
    context.stroke();
    for (let index = 0; index < count; index++) {
      const angle = index * TAU / count + Math.sin(index * 999 + (Number(effect.id) || 0));
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const far = extent * expansion * (index % 2 ? .64 : 1);
      const near = Math.max(0, far - 10 * (1 - age));
      line(context, [x + dx * near, y + dy * near, x + dx * far, y + dy * far], index % 2 ? spark : base, 2.1);
    }
    context.restore();
  }

  window.createTankRenderer = function createTankRenderer(canvas) {
    const context = canvas.getContext("2d");
    if (!context) return { resize() {}, draw() {}, destroy() {} };

    const layer = document.createElement("canvas");
    const layerContext = layer.getContext("2d");
    const miniLayer = document.createElement("canvas");
    const miniContext = miniLayer.getContext("2d");
    let cacheKey;
    let miniCacheKey;
    let disposed = false;
    let lastFrame;
    let awaitingSize = true;
    let pixelRatio = 1;
    let cssWidth = 0;

    function measureCanvas() {
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) {
        awaitingSize = true;
        return false;
      }
      const wasHidden = awaitingSize;
      awaitingSize = false;
      pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      cssWidth = bounds.width;
      const width = Math.max(1, Math.round(bounds.width * pixelRatio));
      const height = Math.max(1, Math.round(bounds.height * pixelRatio));
      if (canvas.width === width && canvas.height === height) return wasHidden;
      canvas.width = width;
      canvas.height = height;
      return true;
    }

    function resize() {
      if (!disposed && measureCanvas() && lastFrame) draw(...lastFrame);
    }

    function drawMinimap(state, view, playerId) {
      const { map } = state;
      const theme = THEMES[map.season] || THEMES.classic;
      const ratio = pixelRatio;
      const panelWidth = (cssWidth < 480 ? 116 : 162) * ratio;
      const padding = 7 * ratio;
      const labelHeight = 18 * ratio;
      const mapWidth = panelWidth - padding * 2;
      const mapHeight = mapWidth * map.height / map.width;
      const panelHeight = mapHeight + padding + labelHeight;
      const panelX = canvas.width - panelWidth - 10 * ratio;
      const panelY = 10 * ratio;
      const mapX = panelX + padding;
      const mapY = panelY + labelHeight;
      const miniScale = mapWidth / map.width;
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      rect(context, panelX, panelY + 2 * ratio, panelWidth, panelHeight, 7 * ratio, "#26382b20");
      rect(context, panelX, panelY, panelWidth, panelHeight, 7 * ratio, "#fffdf3ed");
      rounded(context, panelX, panelY, panelWidth, panelHeight, 7 * ratio);
      context.strokeStyle = "#9aa99185";
      context.lineWidth = ratio;
      context.stroke();
      context.font = `600 ${9 * ratio}px system-ui, sans-serif`;
      context.textAlign = "left";
      context.textBaseline = "middle";
      context.fillStyle = "#64735f";
      context.fillText("全图", panelX + padding, panelY + 9 * ratio);
      const current = (state.players || []).find(player => player.id === playerId);
      dot(context, panelX + panelWidth - 27 * ratio, panelY + 9 * ratio, 2.5 * ratio, current?.color || "#4f80d5");
      context.fillText("你", panelX + panelWidth - 20 * ratio, panelY + 9 * ratio);
      const nextMiniKey = `${map.id}/${map.width}/${map.height}/${map.walls.length}/${Math.round(mapWidth)}`;
      if (miniContext) {
        if (miniCacheKey !== nextMiniKey) {
          miniLayer.width = Math.max(1, Math.round(mapWidth));
          miniLayer.height = Math.max(1, Math.round(mapHeight));
          miniContext.fillStyle = theme.paper;
          miniContext.fillRect(0, 0, miniLayer.width, miniLayer.height);
          miniContext.fillStyle = theme.ink;
          for (const wall of map.walls) {
            miniContext.fillRect(wall.x * miniScale, wall.y * miniScale,
              Math.max(ratio * .6, wall.w * miniScale), Math.max(ratio * .6, wall.h * miniScale));
          }
          miniCacheKey = nextMiniKey;
        }
        context.drawImage(miniLayer, mapX, mapY, mapWidth, mapHeight);
      } else {
        context.fillStyle = theme.paper;
        context.fillRect(mapX, mapY, mapWidth, mapHeight);
      }
      context.strokeStyle = "#657b59";
      context.lineWidth = ratio;
      context.strokeRect(mapX, mapY, mapWidth, mapHeight);
      const viewX = mapX + view.x * miniScale;
      const viewY = mapY + view.y * miniScale;
      const viewWidth = view.width * miniScale;
      const viewHeight = view.height * miniScale;
      context.fillStyle = "#ffffff49";
      context.fillRect(viewX, viewY, viewWidth, viewHeight);
      context.strokeStyle = "#6d8561";
      context.lineWidth = 1.2 * ratio;
      context.strokeRect(viewX, viewY, viewWidth, viewHeight);
      for (const player of state.players || []) {
        if (player.hp <= 0 || player.respawnIn > 0 || player.connected === false) continue;
        const selected = player.id === playerId;
        const radius = (selected ? 3.2 : 2.4) * ratio;
        const x = mapX + player.x * miniScale;
        const y = mapY + player.y * miniScale;
        dot(context, x, y, radius + ratio, "#ffffffe8");
        dot(context, x, y, radius, player.color || PREVIEW_COLORS[0]);
      }
      context.restore();
    }

    function draw(state, options = {}) {
      if (disposed || !state?.map) return;
      lastFrame = [state, options];
      if (awaitingSize && !measureCanvas()) return;
      const { map } = state;
      const { width, height } = canvas;
      const { playerId, preview = false, overview = false, effects = [], time = 0 } = options;
      const current = (state.players || []).find(player => player.id === playerId);
      const follow = !preview && !overview && state.phase === "playing" && current;
      // Keep tanks readable on a phone; desktop view remains about 1200 × 760 world units.
      const referenceWidth = cssWidth < 480 ? 780 : 1200;
      const followScale = Math.max(width / Math.min(map.width, referenceWidth), height / map.height);
      const scale = follow ? followScale : Math.min(width / map.width, height / map.height);
      if (!Number.isFinite(scale) || scale <= 0) return;
      const view = { x: 0, y: 0, width: Math.min(map.width, width / scale), height: Math.min(map.height, height / scale) };
      if (follow) {
        // Input positions have already been interpolated by the controller. No second lagging
        // camera interpolation is needed, so respawns immediately show the new location.
        view.x = Math.max(0, Math.min(map.width - view.width, current.x - view.width / 2));
        view.y = Math.max(0, Math.min(map.height - view.height, current.y - view.height / 2));
      }
      const offsetX = (width - view.width * scale) / 2 - view.x * scale;
      const offsetY = (height - view.height * scale) / 2 - view.y * scale;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.fillStyle = (THEMES[map.season] || THEMES.classic).edge;
      context.fillRect(0, 0, width, height);

      // Preview textures match their small cards. The live map is cached at no more than
      // 1 pixel per world unit / 4.6M pixels, even on high-DPI screens and while zooming.
      const cacheScale = preview ? Math.min(1, scale) : Math.min(1, Math.sqrt(4600000 / (map.width * map.height)));
      const layerWidth = Math.max(1, Math.round(map.width * cacheScale));
      const layerHeight = Math.max(1, Math.round(map.height * cacheScale));
      const nextKey = `${map.id}/${map.width}/${map.height}/${map.walls.length}/${layerWidth}/${layerHeight}`;
      context.save();
      context.setTransform(scale, 0, 0, scale, offsetX, offsetY);
      if (layerContext) {
        if (nextKey !== cacheKey) {
          layer.width = layerWidth;
          layer.height = layerHeight;
          layerContext.setTransform(layerWidth / map.width, 0, 0, layerHeight / map.height, 0, 0);
          drawMap(layerContext, map);
          cacheKey = nextKey;
        }
        context.drawImage(layer, 0, 0, map.width, map.height);
      } else {
        drawMap(context, map);
      }
      context.beginPath();
      context.rect(0, 0, map.width, map.height);
      context.clip();
      if (preview) {
        for (const [index, spawn] of (map.spawns || []).entries()) {
          drawTank(context, { ...spawn, color: PREVIEW_COLORS[index], hp: 100 }, false, true);
        }
      } else {
        const visible = (item, margin = 80) => item.x >= view.x - margin && item.y >= view.y - margin
          && item.x <= view.x + view.width + margin && item.y <= view.y + view.height + margin;
        const labelScale = Math.max(1, Math.min(2.4, 8 * pixelRatio / (13 * scale)));
        for (const item of state.pickups || []) if (visible(item)) drawPickup(context, item, time / 1000);
        for (const bullet of state.bullets || []) if (visible(bullet, 35)) drawBullet(context, bullet, map);
        for (const player of state.players || []) if (visible(player, 150)) drawTank(context, player, player.id === playerId, false, labelScale);
        for (const effect of effects) if (visible(effect)) drawEffect(context, effect);
      }
      context.restore();
      if (follow) drawMinimap(state, view, playerId);
    }

    resize();
    return {
      resize,
      draw,
      destroy() {
        disposed = true;
        lastFrame = undefined;
        layer.width = 0;
        layer.height = 0;
        miniLayer.width = 0;
        miniLayer.height = 0;
      },
    };
  };
})();
