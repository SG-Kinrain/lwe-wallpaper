// SPDX-License-Identifier: GPL-3.0-or-later

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
        this._window = null;
        this._actor = null;
        this._signalIds = [];
        this._timeoutIds = [];
        this._exitCallbacks = [];
        this._exited = true;
        this._stopped = false;
    }

    get monitorIndex() {
        return this._monitorIndex;
    }

    get monitor() {
        return this._monitor;
    }

    get actor() {
        return this._actor;
    }

    get window() {
        return this._window;
    }

    get isReady() {
        return this._window !== null;
    }

    get pid() {
        return this._process ? this._readPid(this._process) : 0;
    }

    start() {
        if (!isEngineAvailable(this._config.engine)) {
            this._logger.error(`renderer not found: ${this._config.engine}`);
            return false;
        }

        const argv = buildEngineArgv(this._config, this._monitor);
        this._logger.debug(`monitor=${this._monitorIndex} spawning ${argv[0]}`);

        try {
            this._process = this._spawn(argv);
        } catch (e) {
            this._logger.error(`monitor=${this._monitorIndex} spawn failed: ${e.message ?? e}`);
            return false;
        }

        this._exited = false;
        this._logger.debug(`monitor=${this._monitorIndex} engine pid=${this._readPid(this._process)}`);

        const process = this._process;
        process.wait_async(null, (proc, res) => {
            try {
                proc.wait_finish(res);
            } catch {
                // cancelled or already reaped
            }
            this._onProcessExited();
        });

        return true;
    }

    // The service waits for this before it starts the replacement engine: a live
    // window is matched by title no matter which process owns it.
    stop(onStopped = null) {
        this._stopped = true;

        for (const [obj, id] of this._signalIds) {
            try {
                obj.disconnect(id);
            } catch {
                // object already destroyed
            }
        }
        this._signalIds = [];

        for (const id of this._timeoutIds)
            GLib.source_remove(id);
        this._timeoutIds = [];

        if (typeof onStopped === 'function') {
            if (this._exited || !this._process)
                onStopped();
            else
                this._exitCallbacks.push(onStopped);
        }

        if (this._process) {
            try {
                this._process.force_exit();
            } catch (e) {
                this._logger.warn(`kill failed: ${e.message ?? e}`);
            }
        }

        this._client = null;
        this._window = null;
        this._actor = null;
    }

    // Hot path: the shell asks this for every window actor on every restack, so it
    // must not do GI calls or string work. Only adopted windows count as ours.
    owns(win) {
        return Boolean(win) && this._window === win;
    }

    matches(win) {
        if (!win || this.isReady)
            return false;

        try {
            if (this._client?.owns_window(win))
                return true;
        } catch {
            // owns_window throws for some window types
        }

        // The engine opens its own Wayland connection, so owns_window usually says
        // no; the title is shared by every instance, which is why engines are
        // started one at a time.
        return `${win.get_title?.() ?? ''}`.toLowerCase().includes('wallpaperengine');
    }

    // A window that is not in the NORMAL layer yet must not be touched:
    // lowering it triggers a mutter assertion and takes the shell down.
    adopt(win, actor) {
        if (this.isReady)
            return false;

        const layer = win.get_layer?.();
        if (layer !== undefined && layer !== Meta.StackLayer.NORMAL) {
            this._logger.debug(`monitor=${this._monitorIndex} window not ready (layer=${layer})`);
            return false;
        }

        this._window = win;
        this._actor = actor;

        if (win.is_fullscreen?.())
            this._unfullscreen(win);

        this._moveToMonitor(win);
        this._keepAtBottom(win);
        this._watchState(win);

        this._signalIds.push([actor, actor.connect('destroy', () => {
            this._window = null;
            this._actor = null;
            this._notifyLost();
        })]);

        const rect = win.get_frame_rect();
        this._logger.debug(`monitor=${this._monitorIndex} window adopted ` +
            `at ${rect.x},${rect.y} ${rect.width}x${rect.height}`);
        this._onReady(this);
        return true;
    }

    _spawn(argv) {
        if (!Meta.WaylandClient)
            throw new Error('Meta.WaylandClient is unavailable');

        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_SILENCE,
        });

        // Meta 18 (GNOME 50) dropped spawnv(); new() alone cannot start a process,
        // so new_subprocess() is the only way in. 48 and older only have the old
        // pair, so probe instead of comparing versions and never call a method that
        // does not exist.
        if (typeof Meta.WaylandClient.new_subprocess === 'function') {
            this._client = Meta.WaylandClient.new_subprocess(global.context, launcher, argv);
            const process = this._client.get_subprocess?.();
            if (!process)
                throw new Error('new_subprocess returned no subprocess');
            return process;
        }

        if (typeof Meta.WaylandClient.new === 'function' &&
            typeof Meta.WaylandClient.spawnv === 'function') {
            this._client = Meta.WaylandClient.new(global.context, launcher);
            const process = this._client.spawnv(global.display, argv);
            if (launcher.close)
                launcher.close();
            return process;
        }

        throw new Error('Meta.WaylandClient has no usable spawn method');
    }

    _readPid(process) {
        try {
            const identifier = process.get_identifier();
            return identifier ? parseInt(identifier, 10) : 0;
        } catch {
            return 0;
        }
    }

    _onProcessExited() {
        if (this._exited)
            return;
        this._exited = true;

        const callbacks = this._exitCallbacks;
        this._exitCallbacks = [];
        for (const callback of callbacks) {
            try {
                callback();
            } catch (e) {
                this._logger.warn(`exit callback failed: ${e.message ?? e}`);
            }
        }

        if (!this._stopped)
            this._notifyLost();
    }

    _watchState(win) {
        for (const property of ['fullscreen', 'maximized-horizontally', 'maximized-vertically']) {
            this._signalIds.push([win, win.connect(`notify::${property}`,
                () => this._resetState(win))]);
        }
    }

    _resetState(win) {
        try {
            if (win.is_fullscreen?.())
                win.unmake_fullscreen();
            if (win.is_maximized?.())
                win.unmaximize(Meta.MaximizeFlags.BOTH);
        } catch (e) {
            this._logger.debug(`reset state failed: ${e.message ?? e}`);
        }
    }

    _unfullscreen(win) {
        try {
            win.unmake_fullscreen();
        } catch (e) {
            this._logger.warn(`unmake_fullscreen failed: ${e.message ?? e}`);
        }
    }

    // GLFW cannot position windows on Wayland, so every instance lands on (0,0) and
    // the occluded ones never get painted, leaving their clone blank.
    _moveToMonitor(win) {
        try {
            win.move_frame(true, this._monitor.x, this._monitor.y);
        } catch (e) {
            this._logger.warn(`move_frame failed: ${e.message ?? e}`);
        }
    }

    _keepAtBottom(win) {
        if (!this._config.keepAtBottom)
            return;

        this._lower(win);
        this._signalIds.push([win, win.connect_after('raised', () => this._lower(win))]);

        for (const delay of LOWER_RETRY_DELAYS_MS) {
            let sourceId = 0;
            sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                this._timeoutIds = this._timeoutIds.filter(id => id !== sourceId);
                if (!this._stopped)
                    this._lower(win);
                return GLib.SOURCE_REMOVE;
            });
            this._timeoutIds.push(sourceId);
        }
    }

    _lower(win) {
        try {
            this._resetState(win);
            win.lower();
        } catch (e) {
            this._logger.debug(`lower failed: ${e.message ?? e}`);
        }
    }

    _notifyLost() {
        if (!this._stopped)
            this._onLost(this);
    }
}
