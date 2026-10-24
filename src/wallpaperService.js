// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {loadConfig, configForMonitor, targetMonitors} from './config.js';
import {setDebug} from './logger.js';
import {describeState} from './diagnostics.js';

const SCAN_INTERVAL_MS = 500;
const SCAN_ATTEMPTS = 20;

export class WallpaperService {
    constructor({Renderer, ShellOverrides, BackgroundCloner, startDiagnostics, logger}) {
        this._Renderer = Renderer;
        this._ShellOverrides = ShellOverrides;
        this._BackgroundCloner = BackgroundCloner;
        this._startDiagnostics = startDiagnostics;
        this._logger = logger;

        this._injectionManager = null;
        this._renderers = new Map();
        this._cloner = null;
        this._config = null;
        this._signalIds = [];
        this._timeoutIds = [];
        this._diagnostics = null;
        this._monitors = [];
        this._targets = [];
        this._failed = new Set();
        this._stackCheckPending = false;
        this._unredirectInhibited = false;
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
        this._spawnRenderers();
        this._scanForRenderers(0);

        if (this._config.debug && this._startDiagnostics) {
            this._diagnostics = this._startDiagnostics({
                renderers: this._renderers,
                logger: this._logger,
            });
        }

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this._enabled) {
                this._cloner?.rebuild();
                this._updateUnredirect();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        this._enabled = false;

        this._diagnostics?.stop();
        this._diagnostics = null;

        if (this._unredirectInhibited) {
            try {
                global.compositor.enable_unredirect?.();
            } catch (e) {
                this._logger.warn(`unredirect release failed: ${e.message ?? e}`);
            }
            this._unredirectInhibited = false;
        }

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
        this._signalIds.push([Main.layoutManager,
            Main.layoutManager.connect('monitors-changed', () => this._restart())]);
        this._signalIds.push([global.display,
            global.display.connect('restacked', () => this._scheduleStackCheck())]);
        this._signalIds.push([global.display,
            global.display.connect('notify::focus-window', () => this._scheduleStackCheck())]);
        this._signalIds.push([global.display,
            global.display.connect('in-fullscreen-changed', () => {
                if (!this._config?.debug)
                    return;
                this._logger.warn(`in-fullscreen-changed: ${describeState(this._renderers)}`);
            })]);

        // Menu grabs make lower() a no-op, so the stack has to be fixed once the
        // menu is gone. Main itself is a module namespace and cannot be patched.
        const service = this;
        try {
            for (const method of ['open', 'close', 'toggle']) {
                this._injectionManager.overrideMethod(PopupMenu.PopupMenu.prototype, method,
                    orig => function (...args) {
                        const result = orig.apply(this, args);
                        service._scheduleStackCheck();
                        return result;
                    });
            }
        } catch (e) {
            this._logger.warn(`menu hooks unavailable: ${e.message ?? e}`);
        }
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

        let sourceId = 0;
        sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCAN_INTERVAL_MS, () => {
            this._timeoutIds = this._timeoutIds.filter(id => id !== sourceId);
            this._scanForRenderers(attempt + 1);
            return GLib.SOURCE_REMOVE;
        });
        this._timeoutIds.push(sourceId);
    }

    _scheduleStackCheck() {
        if (!this._enabled || this._stackCheckPending)
            return;
        this._stackCheckPending = true;
        let sourceId = 0;
        sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._stackCheckPending = false;
            this._timeoutIds = this._timeoutIds.filter(id => id !== sourceId);
            this._enforceStacking();
            this._updateUnredirect();
            return GLib.SOURCE_REMOVE;
        });
        this._timeoutIds.push(sourceId);
    }

    // A monitor-sized topmost window is handed straight to the display, skipping
    // composition, so the panel and dock would never be drawn. Unredirection is
    // refcounted; hold one reference while the renderer is that topmost window.
    _updateUnredirect() {
        const actors = global.get_window_actors(false);
        const ours = new Set();
        for (const renderer of this._renderers.values()) {
            if (renderer.actor)
                ours.add(renderer.actor);
        }

        // Scanout is decided per monitor view, so a window on one screen says
        // nothing about the other: find the topmost window on each monitor.
        const monitors = Main.layoutManager.monitors;
        const decided = new Array(monitors.length).fill(false);
        let inhibit = false;

        for (let i = actors.length - 1; i >= 0 && !inhibit; i--) {
            const actor = actors[i];
            const win = actor.meta_window;
            if (!win)
                continue;

            const rect = win.get_frame_rect();
            for (let m = 0; m < monitors.length; m++) {
                if (decided[m])
                    continue;
                const mon = monitors[m];
                const overlaps = rect.x < mon.x + mon.width &&
                    rect.x + rect.width > mon.x &&
                    rect.y < mon.y + mon.height &&
                    rect.y + rect.height > mon.y;
                if (!overlaps)
                    continue;

                decided[m] = true;
                if (ours.has(actor))
                    inhibit = true;
            }
        }

        if (inhibit === this._unredirectInhibited)
            return;

        try {
            if (inhibit)
                global.compositor.disable_unredirect?.();
            else
                global.compositor.enable_unredirect?.();
            this._unredirectInhibited = inhibit;
            this._logger.debug(`unredirect inhibited=${inhibit}`);
        } catch (e) {
            this._logger.warn(`unredirect toggle failed: ${e.message ?? e}`);
        }
    }

    // mutter restacks on focus, workspace switches and fullscreen exits, and the
    // renderer can end up above application windows, covering the whole screen.
    _enforceStacking() {
        if (!this._enabled || this._config?.keepAtBottom === false)
            return;

        const actors = global.get_window_actors(false);
        const ours = new Set();
        for (const renderer of this._renderers.values()) {
            if (renderer.actor)
                ours.add(renderer.actor);
        }
        if (ours.size === 0)
            return;

        const indexes = [...ours].map(actor => actors.indexOf(actor)).filter(i => i >= 0);
        if (indexes.length === 0)
            return;

        const lowest = Math.min(...indexes);
        const covered = actors.slice(0, lowest).some(actor => {
            const win = actor.meta_window;
            if (!win || win.is_skip_taskbar())
                return false;
            const id = `${win.get_app_id?.() ?? ''}${win.get_title?.() ?? ''}`.toLowerCase();
            if (id.includes('wallpaperengine'))
                return false;
            return [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG,
                    Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY].includes(win.get_window_type());
        });

        if (!covered)
            return;

        this._logger.debug('renderer stacked above an application window, lowering');
        for (const renderer of this._renderers.values())
            renderer.window?.lower();
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

    _stopRenderers() {
        for (const renderer of this._renderers.values())
            renderer.stop();
        this._renderers.clear();
    }

    _restart() {
        if (!this._enabled)
            return;

        this._logger.debug('monitors changed, restarting renderers');
        this._cloner?.destroy();
        this._stopRenderers();
        this._createCloner();
        this._spawnRenderers();
        this._cloner.rebuild();
    }
}
