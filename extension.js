// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 kinrain and contributors

// 入口：按时间戳动态加载 src/，绕开 gjs 的模块缓存以便热重载。

import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const MODULES = [
    'logger.js',
    'shellOverrides.js',
    'backgroundCloner.js',
    'renderer.js',
    'wallpaperService.js',
];

export default class LweWallpaperExtension extends Extension {
    async enable() {
        const base = GLib.filename_to_uri(GLib.build_filenamev([this.path, 'src']), null);
        const version = Date.now();

        let modules;
        try {
            modules = await Promise.all(
                MODULES.map(file => import(`${base}/${file}?v=${version}`)));
        } catch (e) {
            console.error('[lwe] 加载模块失败', e);
            return;
        }

        const [loggerModule, overridesModule, clonerModule, rendererModule, serviceModule] = modules;
        const logger = loggerModule.createLogger();

        this._service = new serviceModule.WallpaperService({
            Renderer: rendererModule.Renderer,
            ShellOverrides: overridesModule.ShellOverrides,
            BackgroundCloner: clonerModule.BackgroundCloner,
            logger,
        });

        try {
            this._service.enable();
            logger.debug(`build=${version}`);
        } catch (e) {
            console.error('[lwe] 启用失败', e);
            this._service = null;
        }
    }

    disable() {
        try {
            this._service?.disable();
        } catch (e) {
            console.error('[lwe] 停用失败', e);
        }
        this._service = null;
    }
}
