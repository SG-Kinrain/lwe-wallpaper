# LWE Wallpaper

把 [Wallpaper Engine]的场景
跑在 GNOME Shell 上，作为**每块显示器独立的动态壁纸**。

GNOME 不支持 Wayland 的 `wlr-layer-shell` 协议，所以常规的壁纸工具（swaybg、hyprpaper 之类）
在 GNOME 上无法工作。本扩展的路线是：

1. 用 `Meta.WaylandClient` 在 shell 内部启动渲染器（`linux-wallpaperengine`），
   让 mutter 把它当作自己的客户端（`layer=NORMAL`，`lower()` 才有效）
2. 注入 `BackgroundManager._createBackgroundActor`，用 `Clutter.Clone` 把渲染窗口的
   画面画进 GNOME 自带的壁纸层
3. 用 `InjectionManager` 把渲染窗口从窗口列表 / Alt-Tab / 概览 / Dock 里摘掉

## 特性

- 每块显示器独立的引擎实例：可以不同场景、不同帧率、不同缩放
- 渲染窗口在窗口栈底层，不遮挡应用；不进 Alt-Tab / 概览 / Dock
- 支持 Wallpaper Engine 的 Scene / Web 场景（取决于上游引擎的兼容性）
- 设置面板集成在 GNOME「扩展」应用里（场景下拉、帧率、缩放、每屏覆盖）
- 修改 `src/` 下的实现后需注销重登（gjs 按 URI 缓存模块）；仅 `prefs.js` / `prefs-ui.js` 例外，每次打开设置都重新读取

## 依赖

| 组件 | 说明 |
|---|---|
| GNOME Shell 48 | 依赖 `Meta.WaylandClient.spawnv`（49 已移除）与 `global.compositor.disable_unredirect`（48 才有） |
| [`linux-wallpaperengine`](https://github.com/Almamu/linux-wallpaperengine) | 必须以 `--window` 模式工作；需自行编译，或放到 `~/.local/bin` |
| Wallpaper Engine 的工坊内容 | Steam 订阅的场景目录（`steamapps/workshop/content/431960`）与 `assets` 目录 |

## 安装

```bash
git clone <repo> ~/src/lwe-wallpaper
cp -r ~/src/lwe-wallpaper/{metadata.json,extension.js,prefs.js,prefs-ui.js,src} \
      ~/.local/share/gnome-shell/extensions/wallpaperengine@waylandwe/
```

然后**注销重新登录一次**（GNOME 在启动时扫描扩展目录并缓存 `hasPrefs`），
在「扩展」应用里启用 **LWE Wallpaper**。

首次配置可以编辑 `~/.config/lwe-wallpaper/config.json`：

```json
{
  "engine": "/home/<user>/.local/bin/linux-wallpaperengine",
  "assets": "/path/to/wallpaper_engine/assets",
  "scene": "/path/to/steamapps/workshop/content/431960/<id>",
  "fps": 60,
  "scaling": "fill",
  "monitors": [],
  "perMonitor": {
    "0": { "fps": 30 },
    "1": { "scene": "/path/to/another/scene" }
  },
  "keepAtBottom": true
}
```

之后可以用「扩展」应用里的设置面板，或直接改这个文件再重载扩展。

## 常见问题

**画面是空白 / 只有一块屏有壁纸**
每块屏需要自己的引擎实例，且每个实例的窗口必须落在自己那块屏上。
GLFW 在 Wayland 下无法定位窗口，扩展会接管后调用 `move_frame()`。
如果屏幕布局变化（拔插显示器），扩展会自动重启全部实例。

**壁纸盖住了所有窗口**
说明渲染窗口没有通过 `Meta.WaylandClient` 启动（`get_layer()` 会是 `LAST`），
此时 `lower()` 无效。检查启动路径与 GNOME 版本。

**Dock 里多出 wallpaperengine 图标**
应用层过滤没生效，需要 override `Shell.App.get_windows` / `get_n_windows` /
`Shell.AppSystem.get_running`（本扩展已包含）。

**崩溃后所有扩展都不见了**
GNOME 崩溃恢复会写入 `org.gnome.shell disable-user-extensions = true`：

```bash
gsettings set org.gnome.shell disable-user-extensions false
```

## 架构

```
extension.js          入口：静态 import + 依赖注入
└── src/wallpaperService.js   编排：配置 → 每屏一个 Renderer（串行启动）→ 就绪后挂克隆
    ├── src/renderer.js       单实例：WaylandClient 启动、窗口接管、定位、全屏/最大化复位
    ├── src/stacking.js       层级守卫（事件驱动）+ 逐屏判断并抑制 direct scanout
    ├── src/backgroundCloner.js  背景 actor 注入 + Clutter.Clone 挂载
    ├── src/shellOverrides.js    窗口层/应用层过滤
    └── src/config.js            默认值、读写、校验、argv 构建
src/logger.js         日志（默认只输出警告/错误，配置文件 debug 打开详细日志）
src/scenes.js         扫描工坊目录、读取场景标题（设置面板使用）
src/shell.js          通过 D-Bus 重启扩展（设置面板"应用"按钮）
prefs.js → prefs-ui.js  GNOME 扩展设置面板（Adw，支持 i18n）
locale/zh_CN/         中文翻译（.mo，由 po/zh_CN.po 编译）
```

依赖方向是单向的：入口 → 服务 → 组件，`config` / `logger` 是叶子。
渲染器不知道背景的存在，背景也不认识渲染器，两者由服务用回调接线。

## 开发

```bash
# 修改实现后（无需注销）
gnome-extensions disable wallpaperengine@waylandwe
gnome-extensions enable wallpaperengine@waylandwe
journalctl --user -b --since '-20s' | grep '\[lwe\]'
```

详细日志默认关闭。把 `"debug": true` 写进配置文件（或设置面板保存后重载）即可看到
`[lwe]` / `[lwe:config]` 等分模块日志；默认只输出警告和错误。

### 翻译

界面文案的源语言是英文，中文在 `po/zh_CN.po`：

```bash
xgettext --language=JavaScript --keyword=_ --from-code=UTF-8 \
         -o po/lwe-wallpaper.pot prefs-ui.js      # 更新模板
msgfmt -c -o locale/zh_CN/LC_MESSAGES/lwe-wallpaper.mo po/zh_CN.po
```

`metadata.json` 里的 `gettext-domain` 与 `.mo` 文件名必须一致（`lwe-wallpaper`）。

## 已知限制

- 锁屏界面显示 GNOME 自己的静态壁纸
- 每块屏一个引擎进程，多屏会线性增加 GPU/CPU 占用
- 依赖 `linux-wallpaperengine` 对具体场景的兼容性
- 仅在 GNOME 48.7 (Wayland, NVIDIA) 上验证

## 许可证

GPL-3.0-or-later，见 [LICENSE](LICENSE)。

依赖的其它项目：

| 项目 | 协议 | 关系 |
|---|---|---|
| [Hanabi](https://github.com/jeffshee/gnome-ext-hanabi) | GPL-3.0-or-later | 架构参考，衍生来源 |
| [linux-wallpaperengine](https://github.com/Almamu/linux-wallpaperengine) | GPL-3.0 | 独立进程，命令行调用，无链接 |
| Wallpaper Engine 本体与工坊内容 | 专有 / 作者版权 | 本仓库不包含 |

感谢 Hanabi 的作者 Jeff Shee 以及 linux-wallpaperengine 的贡献者。

