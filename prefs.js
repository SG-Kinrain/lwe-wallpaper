// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 kinrain and contributors
//
// 本文件是 LWE Wallpaper 的一部分，按 GNU GPL v3 或更新版本发布，不提供任何担保。
// 完整许可文本见仓库根目录 LICENSE。
//
// 扩展内的设置面板入口（GNOME「扩展」应用 → 齿轮）
// 真正的 UI 在 prefs-ui.js，独立窗口和扩展内共用同一份实现。

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {fillPreferencesWindow} from './prefs-ui.js';

export default class LwePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        return fillPreferencesWindow(window);
    }
}
