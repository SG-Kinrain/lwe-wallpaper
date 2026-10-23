// 扩展内的设置面板入口（GNOME「扩展」应用 → 齿轮）
// 真正的 UI 在 prefs-ui.js，独立窗口和扩展内共用同一份实现。

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {fillPreferencesWindow} from './prefs-ui.js';

export default class LwePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        return fillPreferencesWindow(window);
    }
}
