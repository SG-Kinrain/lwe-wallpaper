// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 kinrain and contributors

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {createLogger} from './logger.js';

const log = createLogger('scenes');

export function sceneTitle(path) {
    try {
        const file = GLib.build_filenamev([path, 'project.json']);
        const [ok, bytes] = GLib.file_get_contents(file);
        if (ok) {
            const project = JSON.parse(new TextDecoder().decode(bytes));
            if (project.title)
                return project.title;
        }
    } catch (e) {
        log.debug(`读取场景标题失败: ${e.message ?? e}`);
    }
    return GLib.path_get_basename(path);
}

export function listScenes(workshop) {
    const scenes = [];
    try {
        const dir = Gio.File.new_for_path(workshop);
        const enumerator = dir.enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null))) {
            if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                continue;
            const id = info.get_name();
            const path = GLib.build_filenamev([workshop, id]);
            if (GLib.file_test(GLib.build_filenamev([path, 'project.json']), GLib.FileTest.EXISTS))
                scenes.push({id, path, title: sceneTitle(path)});
        }
    } catch (e) {
        log.warn(`扫描场景目录失败: ${e.message ?? e}`);
    }
    return scenes.sort((a, b) => a.title.localeCompare(b.title));
}
