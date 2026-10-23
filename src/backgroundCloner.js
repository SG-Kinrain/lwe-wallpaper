// 背景克隆：把渲染器窗口的画面画进 GNOME 自己的壁纸层
//
// 做法是注入 BackgroundManager._createBackgroundActor，在 GNOME 建好的背景 actor
// 里挂一个 St.Widget + Clutter.Clone(source = 渲染窗口 actor)。
//
// 为什么不用"把窗口 actor 搬进背景组"：
//   mutter 的 damage region 记账不接受窗口 actor 换父级，会直接 SEGV
//   （pixman_region32_init_rect: Invalid rectangle）。
//
// 为什么不能跳过 0×0 的 actor：
//   GNOME 会先创建 0×0 的背景 actor，之后 resize 而「不重建」，
//   跳过就永远挂不上克隆 → 那块屏一直是静态壁纸。

import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Background from 'resource:///org/gnome/shell/ui/background.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class BackgroundCloner {
    /**
     * @param {(monitorIndex: number) => object|null} getSourceActor 取该显示器渲染窗口的 actor
     * @param {object} logger
     */
    constructor(getSourceActor, logger) {
        this._getSourceActor = getSourceActor;
        this._logger = logger;
        this._actors = new Map();     // monitorIndex → Meta.BackgroundActor
        this._clones = new Map();     // monitorIndex → St.Widget
        this._signals = [];           // [actor, signalId]
    }

    /**
     * 注入背景 actor 创建钩子。卸载由调用方执行 `injectionManager.clear()`。
     * @param {import('resource:///org/gnome/shell/extensions/extension.js').InjectionManager} im
     */
    install(im) {
        const cloner = this;
        im.overrideMethod(
            Background.BackgroundManager.prototype,
            '_createBackgroundActor',
            orig => function () {
                const actor = orig.call(this);
                try {
                    cloner._onBackgroundActor(actor);
                } catch (e) {
                    // 注入失败绝不能影响 shell 本身
                    console.error('[lwe:background]', e);
                }
                return actor;
            }
        );
        this._logger.info('已注入背景 actor 创建');
    }

    /** 让 shell 重建背景 actor（启用时、显示器变化后） */
    rebuild() {
        try {
            Main.layoutManager._updateBackgrounds();
            this._logger.info('已请求重建背景');
        } catch (e) {
            this._logger.warn(`重建背景失败: ${e}`);
        }
    }

    /** 渲染器就绪后调用：顺手补上已有背景 actor 的克隆 */
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
            // 已随背景 actor 一起销毁
        }
    }

    destroy() {
        for (const monitorIndex of [...this._clones.keys()])
            this.detach(monitorIndex);
        for (const [actor, signalId] of this._signals) {
            try {
                actor.disconnect(signalId);
            } catch {
                // actor 已销毁
            }
        }
        this._signals = [];
        this._actors.clear();
    }

    // ------------------------------------------------------------ 内部

    _onBackgroundActor(actor) {
        this._actors.set(actor.monitor, actor);

        // GNOME 重建背景时旧 actor 已销毁，旧克隆必须丢弃重挂
        this.detach(actor.monitor);

        this._logger.info(`背景 actor 就绪 monitor=${actor.monitor} ${actor.width}x${actor.height}`);
        this._attachClone(actor);
    }

    _attachClone(backgroundActor) {
        const monitorIndex = backgroundActor.monitor;
        if (this._clones.has(monitorIndex))
            return;

        const source = this._getSourceActor(monitorIndex);
        if (!source) {
            this._logger.info(`monitor=${monitorIndex} 渲染器未就绪，等它就绪后再挂`);
            return;
        }

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

        const signalId = backgroundActor.connect('notify::allocation', () => {
            if (backgroundActor.width > 0 && backgroundActor.height > 0)
                wrapper.set_size(backgroundActor.width, backgroundActor.height);
        });
        this._signals.push([backgroundActor, signalId]);

        this._logger.info(`已挂克隆 monitor=${monitorIndex} ` +
            `${backgroundActor.width}x${backgroundActor.height}`);
    }
}
