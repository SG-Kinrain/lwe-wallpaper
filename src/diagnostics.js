// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const INTERVAL_MS = 3000;

export function startDiagnostics({renderers, logger}) {
    let sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, INTERVAL_MS, () => {
        if (sourceId === 0)
            return GLib.SOURCE_REMOVE;
        try {
            logger.debug(describe(renderers));
        } catch (e) {
            logger.warn(`diagnostics failed: ${e.message ?? e}`);
        }
        return GLib.SOURCE_CONTINUE;
    });

    return {
        stop() {
            const id = sourceId;
            sourceId = 0;
            if (id > 0)
                GLib.source_remove(id);
        },
    };
}

function describe(renderers) {
    const parts = [];
    parts.push(`panel=${Main.panel?.visible ? 'visible' : 'hidden'}`);

    const fullscreen = Main.layoutManager.monitors.map((_monitor, index) => {
        try {
            return global.display.get_monitor_in_fullscreen(index);
        } catch {
            return 'err';
        }
    });
    parts.push(`inFullscreen=${JSON.stringify(fullscreen)}`);

    const focus = global.display.focus_window;
    parts.push(`focus=${focus ? `${focus.get_app_id?.() ?? '?'}/type${focus.get_window_type()}` : 'none'}`);

    for (const [index, renderer] of renderers) {
        const win = renderer.window;
        if (!win) {
            parts.push(`win${index}=none`);
            continue;
        }
        parts.push(`win${index}=type${win.get_window_type()}` +
            `,fs${win.is_fullscreen()}` +
            `,sized${win.is_monitor_sized?.()}` +
            `,focus${win.has_focus()}` +
            `,layer${win.get_layer()}`);
    }

    const dock = findDashActor();
    parts.push(dock
        ? `dock=visible:${dock.visible},y:${Math.round(dock.y)},opacity:${dock.opacity}`
        : 'dock=notfound');

    return parts.join(' | ');
}

function findDashActor() {
    const queue = [...Main.uiGroup.get_children()];
    while (queue.length > 0) {
        const actor = queue.shift();
        if ((actor.name ?? '').toLowerCase().includes('dash'))
            return actor;
        queue.push(...actor.get_children());
    }
    return null;
}
