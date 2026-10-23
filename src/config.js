// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 kinrain and contributors

import GLib from 'gi://GLib';

import {createLogger} from './logger.js';

const log = createLogger('config');

export const CONFIG_PATH = GLib.build_filenamev([
    GLib.get_user_config_dir(), 'lwe-wallpaper', 'config.json',
]);

export const SCALING_MODES = ['fill', 'fit', 'stretch'];

export const DEFAULT_CONFIG = {
    engine: GLib.build_filenamev([GLib.get_home_dir(), '.local/bin/linux-wallpaperengine']),
    workshop: '/mnt/windows/Program Files (x86)/Steam/steamapps/workshop/content/431960',
    assets: '/mnt/windows/Program Files (x86)/Steam/steamapps/common/wallpaper_engine/assets',
    scene: '',
    fps: 60,
    scaling: 'fill',
    extraArgs: [],
    monitors: [],
    perMonitor: {},
    keepAtBottom: true,
    debug: false,
};

const FPS_MIN = 1;
const FPS_MAX = 240;

function clampFps(value, fallback) {
    const fps = Number(value);
    if (!Number.isFinite(fps))
        return fallback;
    return Math.min(FPS_MAX, Math.max(FPS_MIN, Math.round(fps)));
}

function normalizeScaling(value, fallback) {
    return SCALING_MODES.includes(value) ? value : fallback;
}

export function loadConfig() {
    const config = {...DEFAULT_CONFIG};
    try {
        const [ok, bytes] = GLib.file_get_contents(CONFIG_PATH);
        if (ok)
            Object.assign(config, JSON.parse(new TextDecoder().decode(bytes)));
    } catch (e) {
        log.warn(`读取配置失败，使用默认值: ${e.message ?? e}`);
    }

    config.fps = clampFps(config.fps, DEFAULT_CONFIG.fps);
    config.scaling = normalizeScaling(config.scaling, DEFAULT_CONFIG.scaling);
    config.monitors = Array.isArray(config.monitors) ? config.monitors : [];
    config.perMonitor = config.perMonitor && typeof config.perMonitor === 'object'
        ? config.perMonitor
        : {};
    config.extraArgs = Array.isArray(config.extraArgs) ? config.extraArgs : [];
    return config;
}

export function saveConfig(config) {
    const dir = GLib.path_get_dirname(CONFIG_PATH);
    GLib.mkdir_with_parents(dir, 0o755);
    return GLib.file_set_contents(CONFIG_PATH,
        `${JSON.stringify(config, null, 2)}\n`);
}

export function configForMonitor(config, monitorIndex) {
    const override = config.perMonitor[String(monitorIndex)] ?? {};
    const merged = {...config, ...override};
    return {
        ...merged,
        fps: clampFps(merged.fps, config.fps),
        scaling: normalizeScaling(merged.scaling, config.scaling),
        extraArgs: Array.isArray(merged.extraArgs) ? merged.extraArgs : [],
    };
}

export function targetMonitors(config, monitorCount) {
    const wanted = config.monitors
        .filter(i => Number.isInteger(i) && i >= 0 && i < monitorCount);
    if (wanted.length > 0)
        return wanted;
    return Array.from({length: monitorCount}, (_, i) => i);
}

// 坐标在 Wayland 下会被 GLFW 忽略，真正的定位由 Renderer 通过 move_frame 完成。
export function buildEngineArgv(config, monitor) {
    return [
        config.engine,
        '--window', `${monitor.x}x${monitor.y}x${monitor.width}x${monitor.height}`,
        '--assets-dir', config.assets,
        '--scaling', config.scaling,
        '--fps', String(config.fps),
        '--silent',
        ...config.extraArgs,
        config.scene,
    ];
}

export function isEngineAvailable(path) {
    return Boolean(path) && GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE);
}
