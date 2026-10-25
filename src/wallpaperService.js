// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {loadConfig, configForMonitor, targetMonitors} from './config.js';
import {setDebug} from './logger.js';
import {StackingGuard} from './stacking.js';
import {WakeGuard} from './wakeGuard.js';

const SCAN_INTERVAL_MS = 500;
const SCAN_ATTEMPTS = 20;

export class WallpaperService {
    constructor({Renderer, ShellOverrides, BackgroundCloner, logger}) {
        this._Renderer = Renderer;
        this._ShellOverrides = ShellOverrides;
        this._BackgroundCloner = BackgroundCloner;
        this._logger = logger;

        this._injectionManager = null;
        this._renderers = new Map();
        this._cloner = null;
        this._config = null;
        this._signalIds = [];
        this._timeoutIds = [];
        this._monitors = [];
        this._targets = [];
        this._failed = new Set();
        this._scanSourceId = 0;
        this._stacking = null;
        this._wakeGuard = null;
        this._enabled = false;
    }

    enable() {
        this._config = loadConfig();
        setDebug(this._config.debug);
        this._enabled = true;

        try {
            this._start();
        } catch (e) {
            this.disable();
            throw e;
        }
    }

    _start() {
        this._injectionManager = new InjectionManager();

        const overrides = new this._ShellOverrides(win => this._isRendererWindow(win), this._logger);
        overrides.install(this._injectionManager);

        this._createCloner();
        this._connectShellSignals();
        this._createStackingGuard();
        this._createWakeGuard();
        this._spawnRenderers();

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._enabled) {
                this._cloner?.rebuild();
                this._stacking?.schedule();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        this._enabled = false;

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
        this._scanSourceId = 0;

        this._stacking?.stop();
        this._stacking = null;

        this._wakeGuard?.stop();
        this._wakeGuard = null;

        this._stopRenderers();
        this._cloner?.destroy();
        this._cloner = null;

        this._injectionManager?.clear();
        this._injectionManager = null;
    }

    _isAdopted(win) {
        for (const renderer of this._renderers.values()) {
            if (renderer.window === win)
                return true;
        }
        return false;
    }

    _isRendererWindow(win) {
        for (const renderer of this._renderers.values()) {
            if (renderer.owns(win))
                return true;
        }
        return false;
    }

    _createCloner() {
        this._cloner = new this._BackgroundCloner(
            monitorIndex => this._renderers.get(monitorIndex)?.actor ?? null,
            this._logger);
        this._cloner.install(this._injectionManager);
    }

    _connectShellSignals() {
        this._signalIds.push([global.window_manager,
            global.window_manager.connect_after('map',
                (_wm, actor) => this._offerWindowToRenderers(actor.meta_window))]);
        this._monitorLayout = this._monitorLayoutSignature();
        this._signalIds.push([Main.layoutManager,
            Main.layoutManager.connect('monitors-changed', () => {
                const layout = this._monitorLayoutSignature();
                if (layout === this._monitorLayout)
                    return;
                this._logger.debug(`monitor layout changed: ${layout}`);
                this._monitorLayout = layout;
                this._restart();
            })]);
    }

    // Anything touching XRandR (Wine, games, VNC) can make mutter announce a
    // change without the layout actually changing; restarting on that is churn.
    _monitorLayoutSignature() {
        return Main.layoutManager.monitors
            .map(m => `${m.x},${m.y},${m.width},${m.height}`)
            .join('|');
    }

    _createStackingGuard() {
        this._stacking = new StackingGuard({
            renderers: this._renderers,
            config: this._config,
            logger: this._logger,
            injectionManager: this._injectionManager,
        });
        this._stacking.start();
    }

    _createWakeGuard() {
        this._wakeGuard = new WakeGuard({
            renderers: this._renderers,
            logger: this._logger,
            onStalled: monitorIndex => this._restartRenderer(monitorIndex),
        });
        this._wakeGuard.start();
    }

    _offerWindowToRenderers(win) {
        if (!win || this._isAdopted(win))
            return;

        for (const renderer of this._renderers.values()) {
            if (renderer.isReady || !renderer.matches(win))
                continue;
            const actor = win.get_compositor_private();
            if (actor && renderer.adopt(win, actor))
                return;
        }
    }

    _scanForRenderers(attempt) {
        if (!this._enabled)
            return;

        for (const actor of global.get_window_actors(false))
            this._offerWindowToRenderers(actor.meta_window);

        const pending = [...this._renderers.values()].filter(r => !r.isReady);
        if (pending.length === 0)
            return;

        if (attempt >= SCAN_ATTEMPTS) {
            const titles = global.get_window_actors(false)
                .map(actor => actor.meta_window?.get_title?.() ?? '?');
            this._logger.warn(`${pending.length} renderer(s) produced no window; ` +
                `visible: ${titles.join(' | ')}`);
            for (const renderer of pending) {
                this._failed.add(renderer.monitorIndex);
                this._renderers.delete(renderer.monitorIndex);
                this._cloner?.detach(renderer.monitorIndex);
                renderer.stop();
            }
            this._startNextRenderer();
            return;
        }

        // A retry chain per renderer would duplicate work; keep a single one.
        if (this._scanSourceId) {
            GLib.source_remove(this._scanSourceId);
            this._scanSourceId = 0;
        }

        let sourceId = 0;
        sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCAN_INTERVAL_MS, () => {
            if (this._scanSourceId === sourceId)
                this._scanSourceId = 0;
            this._timeoutIds = this._timeoutIds.filter(id => id !== sourceId);
            this._scanForRenderers(attempt + 1);
            return GLib.SOURCE_REMOVE;
        });
        this._scanSourceId = sourceId;
        this._timeoutIds.push(sourceId);
    }

    // A previous session can leave engines behind (crash, failed enable) and their
    // windows then sit unowned in the stack.
    _killStaleEngines() {
        if (!this._config.engine)
            return;
        try {
            Gio.Subprocess.new(['pkill', '-f', `${this._config.engine} --window`],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            this._logger.debug(`stale engine cleanup failed: ${e.message ?? e}`);
        }
    }

    _spawnRenderers() {
        this._killStaleEngines();
        this._failed = new Set();
        this._monitors = Main.layoutManager.monitors;
        this._targets = targetMonitors(this._config, this._monitors.length)
            .filter(index => this._monitors[index]);
        this._startNextRenderer();
    }

    // One engine at a time: with a single engine window on screen the title match
    // cannot bind two instances to the same window.
    _startNextRenderer() {
        if (!this._enabled)
            return;

        const monitorIndex = this._targets.find(index =>
            !this._renderers.has(index) && !this._failed.has(index));
        if (monitorIndex === undefined)
            return;

        const renderer = new this._Renderer({
            config: configForMonitor(this._config, monitorIndex),
            monitorIndex,
            monitor: this._monitors[monitorIndex],
            logger: this._logger,
            onReady: r => {
                this._cloner?.attach(r.monitorIndex);
                this._startNextRenderer();
            },
            onLost: r => this._cloner?.detach(r.monitorIndex),
        });

        this._renderers.set(monitorIndex, renderer);
        renderer.start();
        this._scanForRenderers(0);
    }

    // A stalled engine keeps its window, so the monitor needs a fresh one; the
    // clone follows through onLost/onReady.
    _restartRenderer(monitorIndex) {
        const renderer = this._renderers.get(monitorIndex);
        if (!renderer)
            return;

        this._renderers.delete(monitorIndex);
        this._cloner?.detach(monitorIndex);
        renderer.stop();
        this._startNextRenderer();
    }

    _stopRenderers() {
        for (const renderer of this._renderers.values())
            renderer.stop();
        this._renderers.clear();
    }

    _restart() {
        if (!this._enabled)
            return;

        this._logger.debug('monitors changed, restarting renderers');
        // Reuse the cloner: its background hook is installed once per enable, and
        // installing it again would wrap the previous override and clone twice.
        this._cloner?.destroy();
        this._stopRenderers();
        this._spawnRenderers();
        this._cloner?.rebuild();
    }
}
