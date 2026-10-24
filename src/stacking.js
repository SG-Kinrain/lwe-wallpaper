// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

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

    _ourActors() {
        const actors = new Set();
        for (const renderer of this._renderers.values()) {
            if (renderer.actor)
                actors.add(renderer.actor);
        }
        return actors;
    }

    // mutter restacks on focus, workspace switches and fullscreen exits, and the
    // renderer can end up above application windows, covering the whole screen.
    _enforceStacking() {
        if (this._config?.keepAtBottom === false)
            return;

        const actors = global.get_window_actors(false);
        const ours = this._ourActors();
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
                    Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY]
                .includes(win.get_window_type());
        });

        if (!covered)
            return;

        this._logger.debug('renderer stacked above an application window, lowering');
        for (const renderer of this._renderers.values())
            renderer.window?.lower();
    }

    // A monitor-sized topmost window is handed straight to the display, skipping
    // composition, so the panel and dock would never be drawn. Unredirection is
    // refcounted; hold one reference while the renderer is that topmost window.
    _updateUnredirect() {
        const actors = global.get_window_actors(false);
        const ours = this._ourActors();

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
}
