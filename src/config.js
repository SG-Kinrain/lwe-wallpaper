// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 kinrain and contributors
//
// 本文件是 LWE Wallpaper 的一部分，按 GNU GPL v3 或更新版本发布，不提供任何担保。
// 完整许可文本见仓库根目录 LICENSE。
//
// 配置：默认值、读写、校验、命令行参数构建
//
// 配置来源是单个 JSON 文件（~/.config/lwe-wallpaper/config.json），
// 扩展面板和命令行工具（lwe-wallpaper）都读写同一份，避免两套状态。

import GLib from 'gi://GLib';

import {createLogger} from './logger.js';

const logger = createLogger('config');

export const CONFIG_PATH = GLib.build_filenamev([
    GLib.get_user_config_dir(), 'lwe-wallpaper', 'config.json',
]);

export const SCALING_MODES = ['fill', 'fit', 'stretch'];

export const DEFAULT_CONFIG = {
    // linux-wallpaperengine 可执行文件
    engine: GLib.build_filenamev([GLib.get_home_dir(), '.local/bin/linux-wallpaperengine']),
    // Steam 工坊目录（用于自动发现场景，仅设置面板/CLI 使用）
    workshop: '/mnt/windows/Program Files (x86)/Steam/steamapps/workshop/content/431960',
    assets: '/mnt/windows/Program Files (x86)/Steam/steamapps/common/wallpaper_engine/assets',
    // 默认场景（目录或 .pkg）
    scene: '',
    fps: 60,
    scaling: 'fill',
    // 传给引擎的额外参数，例如 ['--set-property', 'newproperty=false']
    extraArgs: [],
    // 只在指定显示器索引上启用；空 = 全部
    monitors: [],
    // 单显示器覆盖：{"0": {"scene": "...", "fps": 30, "scaling": "fit"}}
    perMonitor: {},
    // 渲染窗口压到窗口栈底层
    keepAtBottom: true,
};

const FPS_MIN = 1;
const FPS_MAX = 240;

function clampFps(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(FPS_MAX, Math.max(FPS_MIN, Math.round(n)));
}

function normalizeScaling(value, fallback) {
    return SCALING_MODES.includes(value) ? value : fallback;
}

/**
 * 读取配置；任何错误都退化为默认值，绝不让扩展因为坏配置起不来。
 * @returns {typeof DEFAULT_CONFIG}
 */
export function loadConfig() {
    const cfg = {...DEFAULT_CONFIG};
    try {
        const [ok, bytes] = GLib.file_get_contents(CONFIG_PATH);
        if (ok)
            Object.assign(cfg, JSON.parse(new TextDecoder().decode(bytes)));
    } catch (e) {
        logger.warn(`读取配置失败，使用默认值: ${e.message ?? e}`);
    }

    cfg.fps = clampFps(cfg.fps, DEFAULT_CONFIG.fps);
    cfg.scaling = normalizeScaling(cfg.scaling, DEFAULT_CONFIG.scaling);
    cfg.monitors = Array.isArray(cfg.monitors) ? cfg.monitors : [];
    cfg.perMonitor = (cfg.perMonitor && typeof cfg.perMonitor === 'object') ? cfg.perMonitor : {};
    cfg.extraArgs = Array.isArray(cfg.extraArgs) ? cfg.extraArgs : [];
    return cfg;
}

/**
 * 取某块显示器的有效配置（默认值 + 该屏覆盖，并做一次校验）。
 */
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

/**
 * 需要在哪些显示器上启用。空列表表示全部；越界索引会被丢弃。
 */
export function targetMonitors(config, monitorCount) {
    const wanted = config.monitors.filter(i => Number.isInteger(i) && i >= 0 && i < monitorCount);
    if (wanted.length > 0)
        return wanted;
    return Array.from({length: monitorCount}, (_, i) => i);
}

/**
 * 构建 linux-wallpaperengine 的命令行。
 *
 * 注意：GLFW 在 Wayland 下不支持设置窗口位置，坐标照样传（引擎会忽略并警告），
 * 真正的定位由 Renderer.moveToMonitor() 通过 move_frame 完成。
 *
 * @param {object} cfg 该显示器的有效配置
 * @param {{x: number, y: number, width: number, height: number}} monitor
 * @returns {string[]}
 */
export function buildEngineArgv(cfg, monitor) {
    const geometry = `${monitor.x}x${monitor.y}x${monitor.width}x${monitor.height}`;
    return [
        cfg.engine,
        '--window', geometry,
        '--assets-dir', cfg.assets,
        '--scaling', cfg.scaling,
        '--fps', String(cfg.fps),
        '--silent',
        ...cfg.extraArgs,
        cfg.scene,
    ];
}
