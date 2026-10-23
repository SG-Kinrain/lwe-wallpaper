// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 kinrain and contributors

const PREFIX = '[lwe]';
let debugEnabled = false;

export function setDebug(enabled) {
    debugEnabled = Boolean(enabled);
}

export function createLogger(scope = '') {
    const tag = scope ? `${PREFIX}:${scope}` : PREFIX;
    return {
        debug(...args) {
            if (debugEnabled)
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
