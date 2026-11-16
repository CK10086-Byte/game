# 坦克对战

Python 标准库实现的 2–4 人实时坦克对战。无需账号、无需安装第三方依赖。

本目录放在 [CK10086-Byte/game](https://github.com/CK10086-Byte/game) 仓库的 `tank-arena/` 子目录。

## 手机游玩

- 用手机浏览器打开游戏。进入对局后会自动切换到沉浸式战场，横屏和竖屏都可游玩。点「房间」可查看房间信息，点「返回战场」继续对局。 [打开公网游戏](https://pixel-tank-arena.onrender.com/games/tanks/play)
- iPhone 或 iPad 用 Safari 打开游戏，点「分享」→「添加到主屏幕」→「添加」。
- Android 用 Chrome 或 Edge 打开游戏，点游戏内安装按钮，或从浏览器菜单选择「安装应用」或「添加到主屏幕」。
- 联机和单人训练都需要网络连接。

## 本地运行

Python 3.9 或更新版本：

```sh
python3 -B server.py --tank-only --open
```

浏览器打开 http://127.0.0.1:8765/ 。两个独立浏览器页面可用六位房间码加入同一房间。

## Render 部署

在 Render 中关联 `CK10086-Byte/game` 的 `main` 分支，选用以下一种方式。

- 新建 Blueprint，将 Blueprint Path 设为 `tank-arena/render.yaml`。其中 `rootDir: tank-arena` 表示从仓库的该子目录构建和启动。
- 新建 Python Web Service，将 Root Directory 设为 `tank-arena`，再使用本目录 `render.yaml` 中的构建与启动命令，并将健康检查路径设为 `/healthz`。

房间使用单实例内存。Render 提供的 `PORT` 和 `RENDER_EXTERNAL_URL` 会被自动读取。

其他服务器须配置 --public-url https://你的域名 并用 HTTPS 反向代理。游戏运行期间保持单进程、单实例；房间保存在内存中，多实例需另做共享房间设计。服务重启会清空房间。

公网模式只开放坦克页面与 API，不需要学生作品数据库。请勿上传原平台 data 目录、账号凭证或无关资料。

## 规则

W/S 前后移动，A/D 转向，空格开火，每秒一次；子弹第十次反弹后消失。九张地图，医疗包、双发、重炮、护盾随机补给。先击毁五辆或三分钟结束时积分领先者胜。被击毁三秒复活。支持单人训练及手机圆形摇杆。九张地图面积已扩至原来的五倍，M 切换全图与跟随，点击全屏按钮进行对战。
