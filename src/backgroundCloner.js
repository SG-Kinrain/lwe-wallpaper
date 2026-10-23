// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 kinrain and contributors

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// 把渲染器画面克隆进 GNOME 自己的背景 actor。
// 不能把窗口 actor 搬进背景组：mutter 的 damage 记账会因非法矩形直接崩。
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
            this._logger.warn(`重建背景失败: ${e.message ?? e}`);
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
            // 已随背景 actor 销毁
        }
    }

    destroy() {
        for (const monitorIndex of [...this._clones.keys()])
            this.detach(monitorIndex);

        for (const [actor, id] of this._signalIds) {
            try {
                actor.disconnect(id);
            } catch {
                // actor 已销毁
            }
        }
        this._signalIds = [];
        this._actors.clear();
    }

    // GNOME 会先建 0×0 的 actor 再 resize（不重建），因此这里不能按尺寸过滤。
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

        this._logger.debug(`monitor=${monitorIndex} 已挂克隆`);
    }
}
