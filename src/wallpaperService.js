// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {loadConfig, configForMonitor, targetMonitors} from './config.js';
import {setDebug} from './logger.js';

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
        this._stackCheckPending = false;
        this._enabled = false;
    }

    enable() {
        this._config = loadConfig();
        setDebug(this._config.debug);
        this._enabled = true;

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
            if (this._enabled)
                this._cloner?.rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        this._enabled = false;

        this._diagnostics?.stop();
        this._diagnostics = null;

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

        // Panel menus grab input through pushModal/popModal; lower() is a no-op
        // while the grab is held, so the stack has to be fixed once it is gone.
        const service = this;
        for (const method of ['pushModal', 'popModal']) {
            this._injectionManager.overrideMethod(Main, method, orig => function (...args) {
                const result = orig.apply(Main, args);
                service._scheduleStackCheck();
                return result;
            });
        }
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

    _scanForRenderers(attempt) {
        if (!this._enabled)
            return;

        for (const actor of global.get_window_actors(false))
            this._offerWindowToRenderers(actor.meta_window);

        const pending = [...this._renderers.values()].filter(r => !r.isReady);
        if (pending.length === 0)
            return;

        if (attempt >= SCAN_ATTEMPTS) {
            this._logger.warn(`${pending.length} renderer(s) produced no window`);
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
            return GLib.SOURCE_REMOVE;
        });
        this._timeoutIds.push(sourceId);
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
            return [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG,
                    Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY].includes(win.get_window_type());
        });

        if (!covered)
            return;

        this._logger.debug('renderer stacked above an application window, lowering');
        for (const renderer of this._renderers.values())
            renderer.window?.lower();
    }

    _spawnRenderers() {
        const monitors = Main.layoutManager.monitors;
        const targets = targetMonitors(this._config, monitors.length);

        for (const monitorIndex of targets) {
            const monitor = monitors[monitorIndex];
            if (!monitor)
                continue;

            const renderer = new this._Renderer({
                config: configForMonitor(this._config, monitorIndex),
                monitorIndex,
                monitor,
                logger: this._logger,
                onReady: r => this._cloner?.attach(r.monitorIndex),
                onLost: r => this._cloner?.detach(r.monitorIndex),
            });

            this._renderers.set(monitorIndex, renderer);
            renderer.start();
        }
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
