// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 kinrain and contributors
//
// 本文件是 LWE Wallpaper 的一部分，按 GNU GPL v3 或更新版本发布，不提供任何担保。
// 完整许可文本见仓库根目录 LICENSE。
//
// 统一日志：所有输出带 [lwe] 前缀，方便 journalctl 过滤
const PREFIX = '[lwe]';

/**
 * @param {string} scope 模块名，会拼在前缀后面，例如 [lwe:renderer]
 */
export function createLogger(scope = '') {
    const tag = scope ? `${PREFIX}:${scope}` : PREFIX;
    return {
        info(...args) {
            console.log(tag, ...args);
        },
        warn(...args) {
            console.warn(tag, ...args);
        },
        error(...args) {
            console.error(tag, ...args);
        },
    };
}
