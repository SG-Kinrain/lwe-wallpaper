// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 kinrain and contributors

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Workspace from 'resource:///org/gnome/shell/ui/workspace.js';
import * as WorkspaceThumbnail from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

// 渲染窗口必须真实存在（克隆需要它的画面），但不能表现成一个应用。
// Dock 走应用层（Shell.App / AppSystem），只过滤 get_window_actors 是不够的。
export class ShellOverrides {
    constructor(isRenderer, logger) {
        this._isRenderer = isRenderer;
        this._logger = logger;
    }

    install(injectionManager) {
        const isRenderer = win => this._isRenderer(win);
        const self = this;

        injectionManager.overrideMethod(Shell.Global.prototype, 'get_window_actors',
            orig => function (hideRenderer = true) {
                const actors = orig.call(this);
                return hideRenderer
                    ? actors.filter(a => !isRenderer(a.meta_window))
                    : actors;
            });

        injectionManager.overrideMethod(Meta.Display.prototype, 'get_tab_list',
            orig => function (type, workspace) {
                return orig.apply(this, [type, workspace])
                    .filter(win => !isRenderer(win));
            });

        for (const proto of [Workspace.Workspace.prototype,
                             WorkspaceThumbnail.WorkspaceThumbnail.prototype]) {
            injectionManager.overrideMethod(proto, '_isOverviewWindow',
                orig => function (win) {
                    return isRenderer(win) ? false : orig.apply(this, [win]);
                });
        }

        injectionManager.overrideMethod(Shell.WindowTracker.prototype, 'get_window_app',
            orig => function (win) {
                return isRenderer(win) ? null : orig.apply(this, [win]);
            });

        injectionManager.overrideMethod(Shell.App.prototype, 'get_windows',
            orig => function () {
                return orig.call(this).filter(win => !isRenderer(win));
            });

        injectionManager.overrideMethod(Shell.App.prototype, 'get_n_windows',
            _orig => function () {
                return self._countWindows(this);
            });

        injectionManager.overrideMethod(Shell.AppSystem.prototype, 'get_running',
            orig => function () {
                return orig.call(this).filter(app => self._countWindows(app) > 0);
            });

        this._logger.debug('窗口/应用过滤已安装');
    }

    _countWindows(app) {
        try {
            return app.get_windows().length;
        } catch {
            return 0;
        }
    }
}
