// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 kinrain and contributors

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const EXTENSION_UUID = 'wallpaperengine@waylandwe';

const DBUS_NAME = 'org.gnome.Shell.Extensions';
const DBUS_PATH = '/org/gnome/Shell/Extensions';
const DBUS_IFACE = 'org.gnome.Shell.Extensions';
const RESTART_DELAY_MS = 800;

function call(method) {
    Gio.DBus.session.call(DBUS_NAME, DBUS_PATH, DBUS_IFACE, method,
        new GLib.Variant('(s)', [EXTENSION_UUID]), null,
        Gio.DBusCallFlags.NONE, -1, null, null);
}

// 通过扩展系统重启自己，等价于在「扩展」应用里关掉再打开。
export function applyExtension() {
    call('DisableExtension');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTART_DELAY_MS, () => {
        call('EnableExtension');
        return GLib.SOURCE_REMOVE;
    });
}
