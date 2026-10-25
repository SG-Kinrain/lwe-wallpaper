// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const CHECK_INTERVAL_MS = 500;
const MAX_LOWER_ATTEMPTS = 3;
const LOWER_BACKOFF_MS = 30000;

// Keeps the renderer windows out of the way: below application windows, and off
// the compositor's direct scanout path so the shell keeps drawing its own chrome.
export class StackingGuard {
    constructor({renderers, config, logger, injectionManager}) {
        this._renderers = renderers;
        this._config = config;
        this._logger = logger;
        this._injectionManager = injectionManager;
        this._signalIds = [];
        this._idleId = 0;
        this._unredirectInhibited = false;
        this._active = false;
        this._lastCheck = 0;
        this._lowerAttempts = 0;
        this._backoffUntil = 0;
        this._lastDump = 0;
    }

    start() {
        this._active = true;

        this._signalIds.push([global.display,
            global.display.connect('restacked', () => this.schedule())]);
        this._signalIds.push([global.display,
            global.display.connect('notify::focus-window', () => this.schedule())]);

        // Menu grabs make lower() a no-op, so the stack has to be fixed once the
        // menu is gone. Main itself is a module namespace and cannot be patched.
        const guard = this;
        try {
            for (const method of ['open', 'close', 'toggle']) {
                this._injectionManager.overrideMethod(PopupMenu.PopupMenu.prototype, method,
                    orig => function (...args) {
                        const result = orig.apply(this, args);
                        guard.schedule();
                        return result;
                    });
            }
        } catch (e) {
            this._logger.warn(`menu hooks unavailable: ${e.message ?? e}`);
        }
    }

    schedule() {
        if (!this._active || this._idleId)
            return;

        // restacked arrives in bursts (and lower() itself restacks), so collapse
        // them: one check per interval is enough to keep the stack right.
        const now = Date.now();
        if (now < this._backoffUntil || now - this._lastCheck < CHECK_INTERVAL_MS)
            return;
        this._lastCheck = now;

        let sourceId = 0;
        sourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleId = 0;
            if (!this._active)
                return GLib.SOURCE_REMOVE;
            this._enforceStacking();
            this._updateUnredirect();
            return GLib.SOURCE_REMOVE;
        });
        this._idleId = sourceId;
    }

    stop() {
        this._active = false;

        for (const [obj, id] of this._signalIds) {
            try {
                obj.disconnect(id);
            } catch {
                // object already destroyed
            }
        }
        this._signalIds = [];

        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }

        if (this._unredirectInhibited) {
            try {
                global.compositor.enable_unredirect?.();
            } catch (e) {
                this._logger.warn(`unredirect release failed: ${e.message ?? e}`);
            }
            this._unredirectInhibited = false;
        }
    }

    // Windows in stacking order. mutter documents sort_windows_by_stacking as
    // "from lowest to highest"; the actor list makes no such promise.
    _stackedWindows() {
        const ours = new Set();
        for (const renderer of this._renderers.values()) {
            if (renderer.window)
                ours.add(renderer.window);
        }

        const activeWorkspace = global.workspace_manager.get_active_workspace();
        const windows = [];
        for (const actor of global.get_window_actors(false)) {
            if (!actor.visible)
                continue;
            const win = actor.meta_window;
            if (!win || win.minimized || !win.located_on_workspace(activeWorkspace))
                continue;
            windows.push(win);
        }

        return {ours, sorted: global.display.sort_windows_by_stacking(windows)};
    }

    // Diagnostic: one line per coverage episode, throttled, so a report can be
    // read back without a screenshot.
    _dumpStack(tag, sorted, ours) {
        const now = Date.now();
        if (now - this._lastDump < 10000)
            return;
        this._lastDump = now;

        const label = win => {
            let appId = '';
            try {
                appId = win.get_gtk_application_id?.() || win.get_app_id?.() || '';
            } catch (e) {
                appId = '';
            }
            const rect = win.get_frame_rect();
            const mark = ours.has(win) ? '*' : '';
            const flags = [
                win.is_fullscreen() ? 'fs' : '',
                win.maximized_horizontally ? 'maxh' : '',
                win.maximized_vertically ? 'maxv' : '',
                win.is_above() ? 'above' : '',
                win.minimized ? 'min' : '',
            ].filter(f => f).join(',');
            return `${mark}${appId || '?'}/t${win.get_window_type()}/L${win.get_layer()}` +
                `/${rect.width}x${rect.height}+${rect.x}+${rect.y}${flags ? `[${flags}]` : ''}`;
        };

        this._logger.warn(`stack(${tag}) ${sorted.slice(-6).map(label).join(' > ')}`);
    }

    // mutter restacks on focus, workspace switches and fullscreen exits, and the
    // renderer can end up above application windows, covering the whole screen.
    _enforceStacking() {
        if (this._config?.keepAtBottom === false)
            return;

        const {ours, sorted} = this._stackedWindows();
        if (ours.size === 0)
            return;

        const indexes = [];
        sorted.forEach((win, i) => {
            if (ours.has(win))
                indexes.push(i);
        });
        if (indexes.length === 0)
            return;

        const lowest = Math.min(...indexes);
        const covered = sorted.slice(0, lowest).some(win =>
            !win.is_skip_taskbar() &&
            [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG,
             Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY]
                .includes(win.get_window_type()));

        if (!covered) {
            this._lowerAttempts = 0;
            return;
        }

        this._logger.debug('renderer stacked above an application window, lowering');
        this._dumpStack('covered', sorted, ours);
        const before = lowest;
        for (const renderer of this._renderers.values())
            renderer.window?.lower();

        // A lower() that changes nothing means the criteria and mutter disagree,
        // which the backoff below would hide.
        const {ours: again, sorted: resorted} = this._stackedWindows();
        const after = [];
        resorted.forEach((win, i) => {
            if (again.has(win))
                after.push(i);
        });
        const afterLowest = after.length ? Math.min(...after) : -1;
        if (afterLowest >= 0 && afterLowest >= before)
            this._logger.warn(`lower had no effect (lowest ${before} to ${afterLowest})`);

        // If lowering keeps being needed the criteria or mutter disagree; stop
        // fighting the compositor instead of restacking in a loop.
        if (++this._lowerAttempts >= MAX_LOWER_ATTEMPTS) {
            this._lowerAttempts = 0;
            this._backoffUntil = Date.now() + LOWER_BACKOFF_MS;
            this._logger.warn('renderer keeps ending up above app windows, backing off');
        }
    }

    // A monitor-sized topmost window is handed straight to the display, skipping
    // composition, so the panel and dock would never be drawn. Unredirection is
    // refcounted; hold one reference while the renderer is that topmost window.
    _updateUnredirect() {
        const {ours, sorted} = this._stackedWindows();

        // Scanout is decided per monitor view, so a window on one screen says
        // nothing about the other: find the topmost window on each monitor.
        const monitors = Main.layoutManager.monitors;
        const decided = new Array(monitors.length).fill(false);
        let inhibit = false;

        for (let i = sorted.length - 1; i >= 0 && !inhibit; i--) {
            const win = sorted[i];
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
                if (ours.has(win))
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
}
