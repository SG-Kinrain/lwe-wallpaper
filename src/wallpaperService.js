// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 kinrain and contributors
//
// 本文件是 LWE Wallpaper 的一部分，按 GNU GPL v3 或更新版本发布，不提供任何担保。
// 完整许可文本见仓库根目录 LICENSE。
//
// 编排层：把配置、渲染器、背景克隆、外壳覆盖组装起来并管理生命周期
//
// 这里只做"接线"，不碰任何 mutter 细节：
//   配置 → 每块显示器一个 Renderer → Renderer 就绪后通知 BackgroundCloner 挂克隆

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {loadConfig, configForMonitor, targetMonitors} from './config.js';

export class WallpaperService {
    /**
     * @param {object} deps
     * @param {typeof import('./renderer.js').Renderer} deps.Renderer
     * @param {typeof import('./shellOverrides.js').ShellOverrides} deps.ShellOverrides
     * @param {typeof import('./backgroundCloner.js').BackgroundCloner} deps.BackgroundCloner
     * @param {object} deps.logger
     */
    constructor({Renderer, ShellOverrides, BackgroundCloner, logger}) {
        this._Renderer = Renderer;
        this._ShellOverrides = ShellOverrides;
        this._BackgroundCloner = BackgroundCloner;
        this._logger = logger;

        this._injectionManager = null;
        this._renderers = new Map();   // monitorIndex → Renderer
        this._cloner = null;
        this._config = null;
        this._signals = [];
        this._enabled = false;
    }

    // ------------------------------------------------------------ 生命周期

    enable() {
        this._enabled = true;
        this._config = loadConfig();

        this._injectionManager = new InjectionManager();

        const overrides = new this._ShellOverrides(win => this.isRendererWindow(win), this._logger);
        overrides.install(this._injectionManager);

        this._cloner = new this._BackgroundCloner(
            monitorIndex => this._renderers.get(monitorIndex)?.actor ?? null,
            this._logger);
        this._cloner.install(this._injectionManager);

        this._connectShellSignals();
        this._spawnRenderers();
        this._scanForRenderers(0);

        // 背景 actor 通常在扩展启用前就建好了，主动重建一次让注入生效
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._enabled)
                this._cloner.rebuild();
            return GLib.SOURCE_REMOVE;
        });

        const targets = targetMonitors(this._config, Main.layoutManager.monitors.length);
        this._logger.info(`已启用 monitors=[${targets}]`);
    }

    disable() {
        this._enabled = false;

        for (const [obj, signalId] of this._signals) {
            try {
                obj.disconnect(signalId);
            } catch {
                // 对象已销毁
            }
        }
        this._signals = [];

        this._stopRenderers();
        this._cloner?.destroy();
        this._cloner = null;

        this._injectionManager?.clear();
        this._injectionManager = null;

        this._logger.info('已停用');
    }

    /** 供 ShellOverrides 使用：某窗口是否属于任何一个渲染器 */
    isRendererWindow(win) {
        for (const renderer of this._renderers.values()) {
            if (renderer.owns(win))
                return true;
        }
        return false;
    }

    // ------------------------------------------------------------ 接线

    _connectShellSignals() {
        const handleWindow = (_source, win) => this._offerWindowToRenderers(win);

        // 只在窗口 map 之后接管：window-created 时窗口尚未配置，
        // 此时对它 lower()/move_frame() 会触发 mutter 的栈断言并崩溃。
        this._signals.push([global.window_manager,
            global.window_manager.connect_after('map',
                (_wm, actor) => this._offerWindowToRenderers(actor.meta_window))]);
        this._signals.push([Main.layoutManager,
            Main.layoutManager.connect('monitors-changed', () => this._restart())]);
    }

    _scanForRenderers(attempt) {
        if (!this._enabled)
            return;

        for (const actor of global.get_window_actors(false))
            this._offerWindowToRenderers(actor.meta_window);

        const pending = [...this._renderers.values()].filter(r => !r.isReady);
        if (pending.length === 0)
            return;
        if (attempt >= 20) {
            this._logger.warn(`${pending.length} 个渲染器 10 秒内没有出现窗口`);
            return;
        }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            this._scanForRenderers(attempt + 1);
            return GLib.SOURCE_REMOVE;
        });
    }

    _offerWindowToRenderers(win) {
        if (!win)
            return;
        for (const renderer of this._renderers.values()) {
            if (!renderer.matches(win))
                continue;
            const actor = win.get_compositor_private();
            if (actor)
                renderer.adopt(win, actor);
            return;
        }
    }

    // ------------------------------------------------------------ 渲染器

    _spawnRenderers() {
        const monitors = Main.layoutManager.monitors;
        const targets = targetMonitors(this._config, monitors.length);

        for (const monitorIndex of targets) {
            const monitor = monitors[monitorIndex];
            if (!monitor) {
                this._logger.warn(`monitor ${monitorIndex} 不存在，跳过`);
                continue;
            }

            const renderer = new this._Renderer({
                config: configForMonitor(this._config, monitorIndex),
                monitorIndex,
                monitor,
                logger: this._logger,
                onReady: r => this._onRendererReady(r),
                onLost: r => this._onRendererLost(r),
            });

            this._renderers.set(monitorIndex, renderer);
            renderer.start();
        }
    }

    _onRendererReady(renderer) {
        this._logger.info(`monitor=${renderer.monitorIndex} 就绪，挂克隆`);
        this._cloner?.attach(renderer.monitorIndex);
    }

    _onRendererLost(renderer) {
        this._cloner?.detach(renderer.monitorIndex);
    }

    _stopRenderers() {
        for (const renderer of this._renderers.values())
            renderer.stop();
        this._renderers.clear();
    }

    _restart() {
        if (!this._enabled)
            return;
        this._logger.info('显示器变化：重启全部渲染器');
        this._cloner?.destroy();
        this._stopRenderers();
        this._cloner = new this._BackgroundCloner(
            monitorIndex => this._renderers.get(monitorIndex)?.actor ?? null,
            this._logger);
        this._cloner.install(this._injectionManager);
        this._spawnRenderers();
        this._cloner.rebuild();
    }
}
