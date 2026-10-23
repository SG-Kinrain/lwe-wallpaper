// SPDX-License-Identifier: GPL-3.0-or-later

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
            console.error('[lwe] module load failed', e);
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
            console.error('[lwe] enable failed', e);
            this._service = null;
        }
    }

    disable() {
        try {
            this._service?.disable();
        } catch (e) {
            console.error('[lwe] disable failed', e);
        }
        this._service = null;
    }
}
