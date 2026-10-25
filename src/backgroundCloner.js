// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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
        if (!this._isDesktopBackground(actor))
            return;

        this._actors.set(actor.monitor, actor);
        actor.connect('destroy', () => {
            if (this._actors.get(actor.monitor) === actor)
                this._actors.delete(actor.monitor);
        });
        this._attachClone(actor);
    }

    // Workspace thumbnails create their own backgrounds; touching them makes the
    // shell rebuild the whole background group again and again.
    _isDesktopBackground(actor) {
        try {
            return actor.get_parent() === Main.layoutManager._backgroundGroup;
        } catch {
            return false;
        }
    }

    _attachClone(backgroundActor) {
        const monitorIndex = backgroundActor.monitor;
        const source = this._getSourceActor(monitorIndex);
        if (!source)
            return;

        // GNOME 50 builds a replacement background actor and fades the old one
        // out, so move the existing clone instead of adding a second one.
        let wrapper = this._clones.get(monitorIndex);
        if (wrapper) {
            const parent = wrapper.get_parent();
            if (parent === backgroundActor) {
                this._setCloneSource(wrapper, source);
                return;
            }
            parent?.remove_child(wrapper);
        } else {
            wrapper = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                x_expand: true,
                y_expand: true,
            });
            wrapper.add_child(new Clutter.Clone({source}));
            this._clones.set(monitorIndex, wrapper);
        }

        this._setCloneSource(wrapper, source);

        if (backgroundActor.width > 0 && backgroundActor.height > 0)
            wrapper.set_size(backgroundActor.width, backgroundActor.height);

        backgroundActor.add_child(wrapper);

        const id = backgroundActor.connect('notify::allocation', () => {
            if (backgroundActor.width > 0 && backgroundActor.height > 0)
                wrapper.set_size(backgroundActor.width, backgroundActor.height);
        });
        this._signalIds.push([backgroundActor, id]);

        const win = source.meta_window;
        const rect = win ? win.get_frame_rect() : null;
        const src = rect ? `${rect.width}x${rect.height}+${rect.x}+${rect.y}` : 'no-window';
        this._logger.debug(`monitor=${monitorIndex} clone attached ` +
            `bg=${backgroundActor.width}x${backgroundActor.height} src=${src} ` +
            `children=${backgroundActor.get_n_children()}`);
    }

    _setCloneSource(wrapper, source) {
        const clone = wrapper.get_first_child();
        if (clone && clone.source !== source)
            clone.set_source(source);
    }
}
