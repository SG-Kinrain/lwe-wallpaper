// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SETTLE_MS = 2500;
const SAMPLE_MS = 2000;
const MIN_CPUTIME_TICKS = 2;

// Blanking the screen cuts the renderer off from frame callbacks; on wake some
// engines never resume and the clone keeps showing the last frame. The engine's
// own CPU time is the only cheap proof that it still draws.
export class WakeGuard {
    constructor({renderers, logger, onStalled}) {
        this._renderers = renderers;
        this._logger = logger;
        this._onStalled = onStalled;
        this._signalIds = [];
        this._settleId = 0;
        this._sampleId = 0;
    }

    start() {
        if (!Main.screenShield)
            return;

        this._signalIds.push(Main.screenShield.connect('wake-up-screen', () => this._onWake()));
        this._signalIds.push(Main.screenShield.connect('active-changed', () => {
            if (!Main.screenShield.active)
                this._onWake();
        }));
    }

    stop() {
        for (const [obj, id] of this._signalIds) {
            try {
                obj.disconnect(id);
            } catch {
                // object already destroyed
            }
        }
        this._signalIds = [];

        for (const id of [this._settleId, this._sampleId]) {
            if (id)
                GLib.source_remove(id);
        }
        this._settleId = 0;
        this._sampleId = 0;
    }

    // Activity events arrive in bursts while the session unlocks, so sample once
    // the compositor has settled instead of on every signal.
    _onWake() {
        if (this._settleId)
            GLib.source_remove(this._settleId);

        this._settleId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, SETTLE_MS, () => {
            this._settleId = 0;
            this._check();
            return GLib.SOURCE_REMOVE;
        });
    }

    _check() {
        const before = new Map();
        for (const [monitorIndex, renderer] of this._renderers) {
            if (!renderer.isReady)
                continue;
            before.set(monitorIndex, cpuTimeTicks(renderer.pid));
        }

        if (before.size === 0)
            return;

        this._sampleId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, SAMPLE_MS, () => {
            this._sampleId = 0;
            for (const [monitorIndex, ticks] of before) {
                const renderer = this._renderers.get(monitorIndex);
                if (!renderer || !renderer.isReady)
                    continue;

                const now = cpuTimeTicks(renderer.pid);
                if (ticks === null || now === null)
                    continue;
                if (now - ticks >= MIN_CPUTIME_TICKS)
                    continue;

                this._logger.warn(`monitor=${monitorIndex} engine stopped drawing after wake, restarting`);
                this._onStalled(monitorIndex);
            }
            return GLib.SOURCE_REMOVE;
        });
    }
}

// /proc/<pid>/stat lists the command name in parentheses, which may contain
// spaces, so fields are counted from the closing parenthesis.
function cpuTimeTicks(pid) {
    if (!pid)
        return null;

    try {
        const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
        if (!ok)
            return null;

        const text = new TextDecoder().decode(bytes);
        const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
        return Number(fields[11]) + Number(fields[12]);
    } catch {
        return null;
    }
}
