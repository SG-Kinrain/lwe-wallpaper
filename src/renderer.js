// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 kinrain and contributors

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {buildEngineArgv, isEngineAvailable} from './config.js';

const LOWER_RETRY_DELAYS_MS = [400, 1500];

export class Renderer {
    constructor({config, monitorIndex, monitor, logger, onReady = () => {}, onLost = () => {}}) {
        this._config = config;
        this._monitorIndex = monitorIndex;
        this._monitor = monitor;
        this._logger = logger;
        this._onReady = onReady;
        this._onLost = onLost;

        this._process = null;
        this._client = null;
        this._pid = 0;
        this._window = null;
        this._actor = null;
        this._signalIds = [];
        this._timeoutIds = [];
        this._stopped = false;
    }

    get monitorIndex() {
        return this._monitorIndex;
    }

    get actor() {
        return this._actor;
    }

    get isReady() {
        return this._window !== null;
    }

    start() {
        if (!isEngineAvailable(this._config.engine)) {
            this._logger.error(`找不到渲染器: ${this._config.engine}`);
            return false;
        }

        const argv = buildEngineArgv(this._config, this._monitor);
        this._logger.debug(`monitor=${this._monitorIndex} 启动 ${argv[0]}`);

        try {
            this._process = this._spawn(argv);
        } catch (e) {
            this._logger.error(`monitor=${this._monitorIndex} 启动失败: ${e.message ?? e}`);
            return false;
        }

        this._pid = this._readPid(this._process);
        this._logger.debug(`monitor=${this._monitorIndex} 引擎 pid=${this._pid}`);

        this._process.wait_async(null, () => {
            if (!this._stopped)
                this._notifyLost();
        });

        return true;
    }

    stop() {
        this._stopped = true;

        for (const [obj, id] of this._signalIds) {
            try {
                obj.disconnect(id);
            } catch {
                // 对象已销毁
            }
        }
        this._signalIds = [];

        for (const id of this._timeoutIds)
            GLib.source_remove(id);
        this._timeoutIds = [];

        if (this._process) {
            try {
                this._process.force_exit();
            } catch (e) {
                this._logger.warn(`结束进程失败: ${e.message ?? e}`);
            }
        }

        this._process = null;
        this._client = null;
        this._window = null;
        this._actor = null;
        this._pid = 0;
    }

    owns(win) {
        if (!win)
            return false;
        if (this._window === win)
            return true;
        return this.matches(win);
    }

    matches(win) {
        if (!win || this.isReady)
            return false;

        if (this._client) {
            try {
                if (this._client.owns_window(win))
                    return true;
            } catch {
                // owns_window 在部分版本会抛错，退回下面的判断
            }
        }

        if (this._pid && typeof win.get_pid === 'function' && win.get_pid() === this._pid)
            return true;

        const title = (win.get_title?.() ?? '').toLowerCase();
        return title.includes('wallpaperengine');
    }

    // 窗口尚未配置完成时（layer 不是 NORMAL）不能动它，否则会触发 mutter 断言。
    adopt(win, actor) {
        if (this.isReady)
            return false;

        const layer = win.get_layer?.();
        if (layer !== undefined && layer !== Meta.StackLayer.NORMAL) {
            this._logger.debug(`monitor=${this._monitorIndex} 窗口尚未就绪(layer=${layer})`);
            return false;
        }

        this._window = win;
        this._actor = actor;

        if (win.is_fullscreen?.())
            this._unfullscreen(win);

        this._moveToMonitor(win);
        this._keepAtBottom(win);

        this._signalIds.push([actor, actor.connect('destroy', () => {
            this._window = null;
            this._actor = null;
            this._notifyLost();
        })]);

        this._logger.debug(`monitor=${this._monitorIndex} 已接管窗口`);
        this._onReady(this);
        return true;
    }

    _spawn(argv) {
        if (!Meta.WaylandClient)
            throw new Error('Meta.WaylandClient 不可用（需要 GNOME 45+）');

        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_SILENCE,
        });
        this._client = Meta.WaylandClient.new(global.context, launcher);
        const process = this._client.spawnv(global.display, argv);
        if (launcher.close)
            launcher.close();
        return process;
    }

    _readPid(process) {
        try {
            const identifier = process.get_identifier();
            return identifier ? parseInt(identifier, 10) : 0;
        } catch {
            return 0;
        }
    }

    _unfullscreen(win) {
        try {
            win.unmake_fullscreen();
        } catch (e) {
            this._logger.warn(`取消 fullscreen 失败: ${e.message ?? e}`);
        }
    }

    // GLFW 在 Wayland 下无法定位窗口，多个实例会全叠在 (0,0)，
    // 被遮住的窗口 mutter 不绘制，对应的克隆会是空白。
    _moveToMonitor(win) {
        try {
            win.move_frame(true, this._monitor.x, this._monitor.y);
        } catch (e) {
            this._logger.warn(`定位窗口失败: ${e.message ?? e}`);
        }
    }

    _keepAtBottom(win) {
        if (!this._config.keepAtBottom)
            return;

        this._lower(win);
        this._signalIds.push([win, win.connect_after('raised', () => this._lower(win))]);

        for (const delay of LOWER_RETRY_DELAYS_MS) {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._timeoutIds = this._timeoutIds.filter(sourceId => sourceId !== id);
                if (!this._stopped)
                    this._lower(win);
                return GLib.SOURCE_REMOVE;
            });
            this._timeoutIds.push(id);
        }
    }

    _lower(win) {
        try {
            if (win.is_fullscreen?.())
                win.unmake_fullscreen();
            win.lower();
        } catch (e) {
            this._logger.debug(`lower 失败: ${e.message ?? e}`);
        }
    }

    _notifyLost() {
        if (!this._stopped)
            this._onLost(this);
    }
}
