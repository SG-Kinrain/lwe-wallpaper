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

    get window() {
        return this._window;
    }

    get isReady() {
        return this._window !== null;
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

        this._pid = this._readPid(this._process);
        this._logger.debug(`monitor=${this._monitorIndex} engine pid=${this._pid}`);

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
                // object already destroyed
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
                this._logger.warn(`kill failed: ${e.message ?? e}`);
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
        if (!win || this.isReady || !this._client)
            return false;

        try {
            return this._client.owns_window(win);
        } catch {
            return false;
        }
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

        this._logger.debug(`monitor=${this._monitorIndex} window adopted`);
        this._onReady(this);
        return true;
    }

    _spawn(argv) {
        if (!Meta.WaylandClient)
            throw new Error('Meta.WaylandClient is unavailable (GNOME 45+ required)');

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
