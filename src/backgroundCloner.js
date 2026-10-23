// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Reparenting the window actor into the background group crashes mutter
// (pixman: invalid rectangle), so the renderer output is cloned instead.
export class BackgroundCloner {
    constructor(getSourceActor, logger) {
        this._getSourceActor = getSourceActor;
        this._logger = logger;
        this._actors = new Map();
        this._clones = new Map();
        this._signalIds = [];
    }

    install(injectionManager) {
        const cloner = this;
        injectionManager.overrideMethod(
            Background.BackgroundManager.prototype,
            '_createBackgroundActor',
            orig => function () {
                const actor = orig.call(this);
                try {
                    cloner._onBackgroundActor(actor);
                } catch (e) {
                    console.error('[lwe:background]', e);
                }
                return actor;
            }
        );
    }

    rebuild() {
        try {
            Main.layoutManager._updateBackgrounds();
        } catch (e) {
            this._logger.warn(`background rebuild failed: ${e.message ?? e}`);
        }
    }

    attach(monitorIndex) {
        const actor = this._actors.get(monitorIndex);
        if (actor)
            this._attachClone(actor);
    }

    detach(monitorIndex) {
        const wrapper = this._clones.get(monitorIndex);
        if (!wrapper)
            return;
        this._clones.delete(monitorIndex);
        try {
            wrapper.destroy();
        } catch {
            // destroyed together with the background actor
        }
    }

    destroy() {
        for (const monitorIndex of [...this._clones.keys()])
            this.detach(monitorIndex);

        for (const [actor, id] of this._signalIds) {
            try {
                actor.disconnect(id);
            } catch {
                // actor already destroyed
            }
        }
        this._signalIds = [];
        this._actors.clear();
    }

    // GNOME creates the background actor at 0x0 and resizes it later without
    // recreating it, so zero-sized actors must not be skipped.
    _onBackgroundActor(actor) {
        this._actors.set(actor.monitor, actor);
        this.detach(actor.monitor);
        this._attachClone(actor);
    }

    _attachClone(backgroundActor) {
        const monitorIndex = backgroundActor.monitor;
        if (this._clones.has(monitorIndex))
            return;

        const source = this._getSourceActor(monitorIndex);
        if (!source)
            return;

        const wrapper = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        if (backgroundActor.width > 0 && backgroundActor.height > 0)
            wrapper.set_size(backgroundActor.width, backgroundActor.height);

        wrapper.add_child(new Clutter.Clone({source}));
        backgroundActor.add_child(wrapper);
        this._clones.set(monitorIndex, wrapper);

        const id = backgroundActor.connect('notify::allocation', () => {
            if (backgroundActor.width > 0 && backgroundActor.height > 0)
                wrapper.set_size(backgroundActor.width, backgroundActor.height);
        });
        this._signalIds.push([backgroundActor, id]);

        this._logger.debug(`monitor=${monitorIndex} clone attached`);
    }
}
