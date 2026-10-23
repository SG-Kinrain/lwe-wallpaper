// SPDX-License-Identifier: GPL-3.0-or-later

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {createLogger} from './src/logger.js';
import {ShellOverrides} from './src/shellOverrides.js';
import {BackgroundCloner} from './src/backgroundCloner.js';
import {Renderer} from './src/renderer.js';
import {WallpaperService} from './src/wallpaperService.js';
import {startDiagnostics} from './src/diagnostics.js';

export default class LweWallpaperExtension extends Extension {
    enable() {
        const logger = createLogger();
        this._service = new WallpaperService({
            Renderer,
            ShellOverrides,
            BackgroundCloner,
            startDiagnostics,
            logger,
        });

        try {
            this._service.enable();
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
