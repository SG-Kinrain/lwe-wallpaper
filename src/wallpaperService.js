// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {loadConfig, configForMonitor, targetMonitors} from './config.js';
import {setDebug} from './logger.js';
import {StackingGuard} from './stacking.js';
import {WakeGuard} from './wakeGuard.js';

const SCAN_INTERVAL_MS = 500;
const SCAN_ATTEMPTS = 20;
const RESTART_DEBOUNCE_MS = 300;
const STOP_TIMEOUT_MS = 2000;
const RELAUNCH_DELAY_MS = 1500;
const MAX_RELAUNCHES = 3;
const RELAUNCH_WINDOW_MS = 30000;

export class WallpaperService {
    constructor({Renderer, ShellOverrides, BackgroundCloner, logger}) {
        this._Renderer = Renderer;
        this._ShellOverrides = ShellOverrides;
        this._BackgroundCloner = BackgroundCloner;
        this._logger = logger;

        this._injectionManager = null;
        this._renderers = new Map();
        // Windows that belong to the engine even when no renderer adopted them.
        // Orphans must stay out of the shell's window lists and off the scanout
        // path, otherwise they cover the dock on their own.
        this._engineWindows = new Set();
        // Windows that existed before a restart: their engines are being killed,
        // but until the window is gone a title match would bind it to a new
        // renderer and leave the new engine's window unowned.
        this._staleWindows = new Set();
        this._lossCounts = new Map();
        this._cloner = null;
        this._config = null;
        this._signalIds = [];
        this._timeoutIds = [];
        this._monitors = [];
        this._targets = [];
        this._failed = new Set();
        this._scanSourceId = 0;
        this._restartId = 0;
        this._generation = 0;
        this._stopping = false;
        this._restartPending = false;
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
        this._overrides = overrides;

        this._createCloner();
        this._connectShellSignals();
        this._createStackingGuard();
        this._createWakeGuard();
        this._killStaleEngines();
        this._spawnRenderers();

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._enabled)
                return GLib.SOURCE_REMOVE;
            // Seeding the actor map from the live background managers avoids the
            // full teardown _updateBackgrounds() does at every enable.
            if (!this._cloner?.hasActors)
                this._cloner?.rebuild();
            this._stacking?.schedule(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        this._enabled = false;
        this._generation++;

        if (this._restartId) {
            GLib.source_remove(this._restartId);
            this._timeoutIds = this._timeoutIds.filter(id => id !== this._restartId);
            this._restartId = 0;
        }
        this._cancelScan();

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
        this._stopping = false;
        this._restartPending = false;

        this._stacking?.stop();
        this._stacking = null;

        this._wakeGuard?.stop();
        this._wakeGuard = null;

        this._stopRenderers();
        this._cloner?.destroy();
        this._cloner = null;

        this._engineWindows.clear();
        this._staleWindows.clear();
        this._lossCounts.clear();
        this._failed.clear();

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
        if (!win)
            return false;
        if (this._engineWindows.has(win))
            return true;
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
        this._cloner.seed();
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
            .map(m => `${m.x},${m.y},${m.width},${m.height},${m.geometry_scale ?? m.scale ?? ''}`)
            .join('|');
    }

    _createStackingGuard() {
        this._stacking = new StackingGuard({
            renderers: this._renderers,
            engineWindows: this._engineWindows,
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

    // The engine is the only client whose window title is exactly this, so the
    // title is a reliable fallback when owns_window() says no (GLFW opens its own
    // Wayland connection). Matching is done once per window, never in the
    // per-restack filters.
    _registerEngineWindow(win) {
        if (!win || this._engineWindows.has(win))
            return;

        let title = '';
        try {
            title = `${win.get_title?.() ?? ''}`.toLowerCase();
        } catch {
            return;
        }
        if (!title.includes('wallpaperengine'))
            return;

        this._engineWindows.add(win);
        this._signalIds.push([win, win.connect('unmanaged', () => {
            this._engineWindows.delete(win);
            this._staleWindows.delete(win);
        })]);

        // The engine maps a full-screen window before any renderer adopts it. Until
        // it has been moved to its monitor and lowered it is a misplaced copy of
        // the wallpaper on top of the desktop, so keep the actor invisible.
        try {
            const actor = win.get_compositor_private?.();
            if (actor)
                actor.opacity = 0;
        } catch {
            // window already gone
        }

        // The dash associates the window with an app before our filters apply, so
        // it may already show an "unknown application" icon. Ask it to rebuild now
        // instead of waiting for the next app event.
        const app = this._overrides?.getWindowApp(win);
        if (app) {
            try {
                Shell.AppSystem.get_default().emit('app-state-changed', app);
            } catch (e) {
                this._logger.debug(`app-state refresh failed: ${e.message ?? e}`);
            }
        }
    }

    _offerWindowToRenderers(win) {
        if (!win || this._isAdopted(win) || this._staleWindows.has(win))
            return;

        this._registerEngineWindow(win);

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
        this._cancelScan();

        this._scanSourceId = this._addTimeout(SCAN_INTERVAL_MS, () => {
            this._scanSourceId = 0;
            this._scanForRenderers(attempt + 1);
        });
    }

    _cancelScan() {
        if (!this._scanSourceId)
            return;
        GLib.source_remove(this._scanSourceId);
        this._timeoutIds = this._timeoutIds.filter(id => id !== this._scanSourceId);
        this._scanSourceId = 0;
    }

    _addTimeout(delayMs, callback) {
        let sourceId = 0;
        sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._timeoutIds = this._timeoutIds.filter(id => id !== sourceId);
            if (this._enabled)
                callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeoutIds.push(sourceId);
        return sourceId;
    }

    // A previous session can leave engines behind (crash, failed enable) and their
    // windows then sit unowned in the stack. Wait for pkill so it cannot race the
    // engines this instance is about to start.
    _killStaleEngines() {
        if (!this._config.engine)
            return;
        try {
            const process = Gio.Subprocess.new(['pkill', '-f', `${this._config.engine} --window`],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            process.wait(null);
        } catch (e) {
            this._logger.debug(`stale engine cleanup failed: ${e.message ?? e}`);
        }
    }

    _spawnRenderers() {
        this._failed = new Set();
        this._lossCounts.clear();
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
            onLost: r => this._onRendererLost(r),
        });

        this._renderers.set(monitorIndex, renderer);

        // An engine window from the previous instance may still be alive while its
        // process is being reaped; the fresh renderer must not adopt it.
        for (const win of this._engineWindows) {
            try {
                if (!win.minimized)
                    this._staleWindows.add(win);
            } catch {
                // window already gone
            }
        }

        if (!renderer.start()) {
            // A broken engine path must not block the remaining monitors.
            this._renderers.delete(monitorIndex);
            this._failed.add(monitorIndex);
            this._startNextRenderer();
            return;
        }
        this._scanForRenderers(0);
    }

    // Engines die with their process (crash, driver reset); without a relaunch the
    // monitor keeps a blank background forever.
    _onRendererLost(renderer) {
        const monitorIndex = renderer.monitorIndex;

        // Ownership first: a renderer that the service already replaced must not
        // detach the clone of its successor.
        if (this._renderers.get(monitorIndex) !== renderer)
            return;

        this._renderers.delete(monitorIndex);
        renderer.stop();
        this._cloner?.detach(monitorIndex);

        const now = Date.now();
        const entry = this._lossCounts.get(monitorIndex) ?? {count: 0, since: now};
        if (now - entry.since > RELAUNCH_WINDOW_MS) {
            entry.count = 0;
            entry.since = now;
        }
        entry.count++;
        this._lossCounts.set(monitorIndex, entry);

        if (entry.count > MAX_RELAUNCHES) {
            this._logger.warn(`monitor=${monitorIndex} engine keeps disappearing, giving up`);
            this._failed.add(monitorIndex);
            this._lossCounts.delete(monitorIndex);
            return;
        }

        this._logger.debug(`monitor=${monitorIndex} engine lost, relaunching`);
        this._addTimeout(RELAUNCH_DELAY_MS, () => this._startNextRenderer());
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

    // The old engines have to be gone before new ones start: their windows still
    // carry the engine title, and a new renderer that adopts one of them ends up
    // cloning a window that is about to be destroyed.
    _stopRenderers(onStopped = null) {
        const renderers = [...this._renderers.values()];
        this._renderers.clear();

        if (renderers.length === 0) {
            onStopped?.();
            return;
        }

        let remaining = renderers.length;
        let settled = false;
        let timeoutId = 0;

        const finish = () => {
            if (settled)
                return;
            settled = true;
            if (timeoutId) {
                GLib.source_remove(timeoutId);
                this._timeoutIds = this._timeoutIds.filter(id => id !== timeoutId);
                timeoutId = 0;
            }
            onStopped?.();
        };

        timeoutId = this._addTimeout(STOP_TIMEOUT_MS, finish);
        for (const renderer of renderers) {
            renderer.stop(() => {
                if (--remaining === 0)
                    finish();
            });
        }
    }

    _restart() {
        if (!this._enabled)
            return;

        // A plug/unplug cycle emits monitors-changed several times; restart once.
        if (this._restartId) {
            GLib.source_remove(this._restartId);
            this._timeoutIds = this._timeoutIds.filter(id => id !== this._restartId);
        }
        this._restartId = this._addTimeout(RESTART_DEBOUNCE_MS, () => {
            this._restartId = 0;
            this._restartNow();
        });
    }

    _restartNow() {
        if (!this._enabled)
            return;

        // A newer monitors-changed arrived while the old engines were still
        // dying; run once more when the stop has finished instead of spawning
        // into a stack that still holds the previous generation's windows.
        if (this._stopping) {
            this._restartPending = true;
            return;
        }

        const generation = ++this._generation;
        this._logger.debug(`monitors changed (${Main.layoutManager.monitors.length}), restarting`);

        this._cancelScan();
        this._rememberStaleWindows();

        // GNOME 50 rebuilds every background actor before it emits monitors-changed,
        // so the actor map already points at the new ones: only the clones that
        // referenced the killed engines have to go.
        this._cloner?.detachAll();

        this._stopping = true;
        this._stopRenderers(() => {
            this._stopping = false;

            if (this._restartPending) {
                this._restartPending = false;
                this._restartNow();
                return;
            }

            if (!this._enabled || generation !== this._generation)
                return;

            this._spawnRenderers();
            this._stacking?.schedule(true);
        });
    }

    _rememberStaleWindows() {
        this._staleWindows.clear();
        for (const actor of global.get_window_actors(false)) {
            const win = actor.meta_window;
            if (win)
                this._staleWindows.add(win);
        }
    }
}
