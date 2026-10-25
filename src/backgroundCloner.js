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
        // monitorIndex -> the background actor that currently parents the wrapper.
        // When that actor is destroyed the wrapper goes with it and must not be
        // handed to the replacement actor.
        this._cloneOwners = new Map();
        // monitorIndex -> [backgroundActor, allocation signal id]
        this._allocationSignals = new Map();
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

    get hasActors() {
        return this._actors.size > 0;
    }

    // The shell already has one background actor per monitor when the extension is
    // enabled; registering those avoids the teardown (and visible flash) that
    // _updateBackgrounds() would cause.
    seed() {
        const managers = Main.layoutManager._bgManagers ?? [];
        for (const manager of managers) {
            const actor = manager.backgroundActor;
            if (actor)
                this._onBackgroundActor(actor);
        }
        return this._actors.size > 0;
    }

    rebuild() {
        try {
            // GNOME 50 made _updateBackgrounds() async. Its rejection has to be
            // handled here or a cancelled background load shows up as an unhandled
            // promise rejection in the shell log.
            const pending = Main.layoutManager._updateBackgrounds();
            pending?.catch?.(e => this._logger.debug(`background rebuild failed: ${e.message ?? e}`));
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
        this._clearAllocationSignal(monitorIndex);
        this._cloneOwners.delete(monitorIndex);

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

    // Keep the background actor map: after a monitor change GNOME has already
    // replaced the actors, so only the clones that point at killed engines are
    // stale.
    detachAll() {
        for (const monitorIndex of [...this._clones.keys()])
            this.detach(monitorIndex);
    }

    destroy() {
        this.detachAll();

        for (const monitorIndex of [...this._allocationSignals.keys()])
            this._clearAllocationSignal(monitorIndex);

        this._actors.clear();
        this._cloneOwners.clear();
    }

    // GNOME creates the background actor at 0x0 and resizes it later without
    // recreating it, so zero-sized actors must not be skipped.
    _onBackgroundActor(actor) {
        if (!this._isDesktopBackground(actor))
            return;

        this._actors.set(actor.monitor, actor);
        actor.connect('destroy', () => this._forgetBackgroundActor(actor));
        this._attachClone(actor);
    }

    // The wrapper is a child of the background actor, so it is destroyed together
    // with it. Dropping the references here is what keeps _attachClone from using
    // a disposed widget when GNOME swaps the actor after a monitor change.
    _forgetBackgroundActor(actor) {
        const monitorIndex = actor.monitor;
        if (this._actors.get(monitorIndex) === actor)
            this._actors.delete(monitorIndex);

        // Only the actor that still owns the wrapper invalidates it; an old actor
        // fading out after a swap no longer does.
        if (this._cloneOwners.get(monitorIndex) !== actor)
            return;

        this._cloneOwners.delete(monitorIndex);
        this._clones.delete(monitorIndex);
        this._clearAllocationSignal(monitorIndex);
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
            let parent = null;
            let alive = false;
            try {
                parent = wrapper.get_parent();
                // A disposed actor still answers get_parent(); the clone is the
                // wrapper's only child, so use it as the liveness check.
                alive = Boolean(wrapper.get_first_child());
            } catch {
                alive = false;
            }

            if (alive && parent === backgroundActor) {
                this._setCloneSource(wrapper, source);
                this._cloneOwners.set(monitorIndex, backgroundActor);
                return;
            }

            if (alive && parent) {
                try {
                    parent.remove_child(wrapper);
                } catch {
                    alive = false;
                }
            }

            if (!alive) {
                this._clones.delete(monitorIndex);
                this._cloneOwners.delete(monitorIndex);
                wrapper = null;
            }
        }

        if (!wrapper) {
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
        this._cloneOwners.set(monitorIndex, backgroundActor);
        this._watchAllocation(monitorIndex, backgroundActor, wrapper);

        const win = source.meta_window;
        const rect = win ? win.get_frame_rect() : null;
        const src = rect ? `${rect.width}x${rect.height}+${rect.x}+${rect.y}` : 'no-window';
        this._logger.debug(`monitor=${monitorIndex} clone attached ` +
            `bg=${backgroundActor.width}x${backgroundActor.height} src=${src} ` +
            `children=${backgroundActor.get_n_children()}`);
    }

    _setCloneSource(wrapper, source) {
        try {
            const clone = wrapper.get_first_child();
            if (clone && clone.source !== source)
                clone.set_source(source);
        } catch (e) {
            this._logger.debug(`clone source update failed: ${e.message ?? e}`);
        }
    }

    // One handler per monitor: reusing the wrapper must not stack a new
    // notify::allocation on every background rebuild.
    _watchAllocation(monitorIndex, backgroundActor, wrapper) {
        this._clearAllocationSignal(monitorIndex);

        const id = backgroundActor.connect('notify::allocation', () => {
            try {
                if (backgroundActor.width > 0 && backgroundActor.height > 0)
                    wrapper.set_size(backgroundActor.width, backgroundActor.height);
            } catch {
                // actor or wrapper already destroyed
            }
        });
        this._allocationSignals.set(monitorIndex, [backgroundActor, id]);
    }

    _clearAllocationSignal(monitorIndex) {
        const entry = this._allocationSignals.get(monitorIndex);
        if (!entry)
            return;
        this._allocationSignals.delete(monitorIndex);
        try {
            entry[0].disconnect(entry[1]);
        } catch {
            // actor already destroyed
        }
    }
}
