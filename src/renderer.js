// 单个渲染实例：启动 linux-wallpaperengine，接管它开的窗口，让它"消失"在窗口栈底层
//
// 关键点（每一条都是踩坑换来的）：
//   1. 必须用 Meta.WaylandClient 启动。用 Gio.Subprocess 起的窗口 get_layer() 是 LAST(8)，
//      mutter 不认它的归属，lower() 完全无效 → 壁纸盖在所有窗口之上。
//   2. Wayland 下 GLFW 不能定位窗口，两个实例会全叠在 (0,0)；
//      被遮住的那个 mutter 不绘制 → 对应显示器的克隆是空白。
//      所以接管后必须 move_frame() 把它挪到自己那块屏。
//   3. 不能最小化渲染窗口：源 actor 隐藏时 Clutter.Clone 不绘制，壁纸会消失。

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {buildEngineArgv} from './config.js';

const RENDERER_TITLE_HINT = 'wallpaperengine';
const LOWER_RETRY_DELAYS_MS = [400, 1500];

export class Renderer {
    /**
     * @param {object} options
     * @param {object} options.config 该显示器的有效配置
     * @param {number} options.monitorIndex
     * @param {object} options.monitor {x,y,width,height}
     * @param {object} options.logger
     * @param {(renderer: Renderer) => void} [options.onReady] 窗口接管完成后回调
     * @param {(renderer: Renderer) => void} [options.onLost]  窗口/进程消失时回调
     */
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
        this._signals = [];
        this._stopped = false;
    }

    get monitorIndex() {
        return this._monitorIndex;
    }

    get actor() {
        return this._actor;
    }

    get pid() {
        return this._pid;
    }

    get isReady() {
        return this._window !== null;
    }

    // ------------------------------------------------------------ 生命周期

    start() {
        const argv = buildEngineArgv(this._config, this._monitor);
        this._logger.info(`启动 monitor=${this._monitorIndex} ` +
            `${this._monitor.width}x${this._monitor.height}@(${this._monitor.x},${this._monitor.y})`);

        try {
            this._process = this._spawnViaWaylandClient(argv);
        } catch (e) {
            this._logger.error(`启动失败: ${e.message ?? e}`);
            return false;
        }

        if (!this._process) {
            this._logger.error('启动失败：没有拿到进程句柄');
            return false;
        }

        this._pid = this._readPid(this._process);
        this._logger.info(`monitor=${this._monitorIndex} 引擎 pid=${this._pid}`);

        this._process.wait_async(null, () => {
            if (this._stopped)
                return;
            this._logger.warn(`monitor=${this._monitorIndex} 引擎进程退出`);
            this._notifyLost();
        });

        return true;
    }

    stop() {
        this._stopped = true;
        for (const [obj, signalId] of this._signals) {
            try {
                obj.disconnect(signalId);
            } catch {
                // 对象已销毁
            }
        }
        this._signals = [];

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

    // ------------------------------------------------------------ 窗口接管

    /** 这个窗口是不是本实例的渲染窗口 */
    matches(win) {
        if (!win || this.isReady)
            return false;

        if (this._client) {
            try {
                if (this._client.owns_window(win))
                    return true;
            } catch {
                // owns_window 在部分版本上会抛错，退回下面的启发式
            }
        }

        if (this._pid && typeof win.get_pid === 'function' && win.get_pid() === this._pid)
            return true;

        const title = (win.get_title?.() ?? '').toLowerCase();
        return title.includes(RENDERER_TITLE_HINT);
    }

    /** 该窗口是否属于本实例（含已接管的窗口，override 过滤要用） */
    owns(win) {
        if (!win)
            return false;
        if (this._window === win)
            return true;
        return this.matches(win);
    }

    /**
     * 接管窗口：定位到自己那块屏、压到窗口栈底层，并通知调用方可以挂克隆了。
     * @param {Meta.Window} win
     * @param {Clutter.Actor} actor
     */
    adopt(win, actor) {
        if (this.isReady)
            return false;

        // 窗口还没配置完时（layer 为 LAST/DOCK）对它 lower/move 会踩 mutter 断言，
        // 必须等它落到 NORMAL 层再接管；service 的轮询会重试。
        const layer = win.get_layer?.();
        if (layer !== undefined && layer !== Meta.StackLayer.NORMAL) {
            this._logger.info(`monitor=${this._monitorIndex} 窗口尚未就绪(layer=${layer})，稍后重试`);
            return false;
        }

        this._window = win;
        this._actor = actor;

        this._logger.info(`接管 monitor=${this._monitorIndex} ` +
            `layer=${win.get_layer?.()} fullscreen=${win.is_fullscreen?.() ?? false} ` +
            `title=${win.get_title?.() ?? ''}`);

        // fullscreen 属于全屏层，lower() 对它无效
        if (win.is_fullscreen?.())
            this._unfullscreen(win);

        this._moveToMonitor(win);
        this._keepAtBottom(win);

        this._signals.push([actor, actor.connect('destroy', () => {
            this._logger.warn(`monitor=${this._monitorIndex} 渲染 actor 销毁`);
            this._window = null;
            this._actor = null;
            this._notifyLost();
        })]);

        this._onReady(this);
        return true;
    }

    // ------------------------------------------------------------ 内部

    _spawnViaWaylandClient(argv) {
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
            const ident = process.get_identifier();
            return ident ? parseInt(ident, 10) : 0;
        } catch {
            return 0;
        }
    }

    _unfullscreen(win) {
        try {
            win.unmake_fullscreen();
            this._logger.info(`monitor=${this._monitorIndex} 已取消 fullscreen`);
        } catch (e) {
            this._logger.warn(`取消 fullscreen 失败: ${e.message ?? e}`);
        }
    }

    _moveToMonitor(win) {
        try {
            win.move_frame(true, this._monitor.x, this._monitor.y);
            const rect = win.get_frame_rect();
            this._logger.info(`monitor=${this._monitorIndex} 定位 → ` +
                `(${rect.x},${rect.y}) ${rect.width}x${rect.height}`);
        } catch (e) {
            this._logger.warn(`定位失败: ${e.message ?? e}`);
        }
    }

    _keepAtBottom(win) {
        if (!this._config.keepAtBottom)
            return;

        this._lower(win);

        // 用户点到桌面时窗口可能被抬起
        this._signals.push([win, win.connect_after('raised', () => this._lower(win))]);

        // 刚映射时 mutter 可能还没算完栈，有限次补压（不是定时器循环）
        for (const delay of LOWER_RETRY_DELAYS_MS) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                if (!this._stopped)
                    this._lower(win);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _lower(win) {
        try {
            if (win.is_fullscreen?.())
                win.unmake_fullscreen();
            win.lower();
        } catch (e) {
            this._logger.warn(`lower 失败: ${e.message ?? e}`);
        }
    }

    _notifyLost() {
        if (this._stopped)
            return;
        this._onLost(this);
    }
}
