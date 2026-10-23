// 把渲染器窗口从 GNOME Shell 的各种列表里摘掉
//
// 渲染窗口必须真实存在（克隆需要它的画面），但不能表现成一个应用：
//   - 不在窗口列表 / Alt-Tab / 概览 / 工作区缩略图里
//   - 不被应用追踪器认领
//   - 不出现在 Dock / Dash to Dock（这条走应用层，最容易漏）

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

export class ShellOverrides {
    /**
     * @param {(win: Meta.Window) => boolean} isRenderer 判定某个窗口是否属于渲染器
     * @param {object} logger
     */
    constructor(isRenderer, logger) {
        this._isRenderer = isRenderer;
        this._logger = logger;
    }

    /**
     * 把全部 override 装进给定的 InjectionManager。
     * 卸载由调用方执行 `im.clear()`。
     * @param {import('resource:///org/gnome/shell/extensions/extension.js').InjectionManager} im
     */
    install(im) {
        const isRenderer = win => this._isRenderer(win);
        const self = this;

        // 窗口列表：Dash to Dock 之外的绝大多数外壳逻辑都从这里取窗口
        im.overrideMethod(Shell.Global.prototype, 'get_window_actors',
            orig => function (hideRenderer = true) {
                const actors = orig.call(this);
                return hideRenderer
                    ? actors.filter(a => !isRenderer(a.meta_window))
                    : actors;
            });

        im.overrideMethod(Meta.Display.prototype, 'get_tab_list',
            orig => function (type, workspace) {
                return orig.apply(this, [type, workspace])
                    .filter(win => !isRenderer(win));
            });

        for (const proto of [Workspace.Workspace.prototype,
                             WorkspaceThumbnail.WorkspaceThumbnail.prototype]) {
            im.overrideMethod(proto, '_isOverviewWindow',
                orig => function (win) {
                    return isRenderer(win) ? false : orig.apply(this, [win]);
                });
        }

        im.overrideMethod(Shell.WindowTracker.prototype, 'get_window_app',
            orig => function (win) {
                return isRenderer(win) ? null : orig.apply(this, [win]);
            });

        // 应用层：Dock / 任务栏据此列出"正在运行的应用"
        im.overrideMethod(Shell.App.prototype, 'get_windows',
            orig => function () {
                return orig.call(this).filter(win => !isRenderer(win));
            });

        im.overrideMethod(Shell.App.prototype, 'get_n_windows',
            _orig => function () {
                return self._countWindows(this);
            });

        im.overrideMethod(Shell.AppSystem.prototype, 'get_running',
            orig => function () {
                return orig.call(this).filter(app => self._countWindows(app) > 0);
            });

        this._logger.info('已安装窗口/应用过滤');
    }

    _countWindows(app) {
        try {
            return app.get_windows().length;
        } catch {
            return 0;
        }
    }
}
