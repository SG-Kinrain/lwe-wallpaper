// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    CONFIG_PATH, DEFAULT_CONFIG, SCALING_MODES,
    isEngineAvailable, loadConfig, saveConfig,
} from './src/config.js';
import {sceneTitle, listScenes} from './src/scenes.js';
import {applyExtension} from './src/shell.js';

export default class LwePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const config = loadConfig();
        const scenes = listScenes(config.workshop);
        let monitorCount = 1;
        try {
            monitorCount = Gdk.Display.get_default()?.get_monitors()?.get_n_items() ?? 1;
        } catch (e) {
            console.error('[lwe] cannot count monitors', e);
        }
        monitorCount = Math.max(monitorCount,
            ...Object.keys(config.perMonitor ?? {}).map(k => Number(k) + 1), 1);

        const page = new Adw.PreferencesPage({
            title: _('Wallpaper'),
            icon_name: 'preferences-desktop-wallpaper-symbolic',
        });
        window.add(page);

        this._buildEngineGroup(page, config);
        this._buildDefaultGroup(page, config, scenes);
        this._buildPerMonitorGroup(page, config, scenes, monitorCount);
        this._buildActions(page, config);
    }

    _buildEngineGroup(page, config) {
        const group = new Adw.PreferencesGroup({title: _('Renderer')});
        page.add(group);

        const missing = !isEngineAvailable(config.engine);
        if (missing) {
            const banner = new Adw.Banner({
                title: _('linux-wallpaperengine not found'),
                revealed: true,
            });
            group.add(banner);
        }

        const row = new Adw.EntryRow({title: _('Executable')});
        row.text = config.engine ?? '';
        row.connect('changed', () => {
            config.engine = row.text;
        });
        group.add(row);
    }

    _buildDefaultGroup(page, config, scenes) {
        const group = new Adw.PreferencesGroup({title: _('Wallpaper')});
        page.add(group);

        const paths = scenes.map(scene => scene.path);
        const model = new Gtk.StringList();
        for (const scene of scenes)
            model.append(`${scene.title} (${scene.id})`);

        const selected = paths.indexOf(config.scene);
        const sceneRow = new Adw.ComboRow({
            title: _('Scene'),
            subtitle: config.scene ? sceneTitle(config.scene) : _('None'),
            model,
            selected: selected >= 0 ? selected : Gtk.INVALID_LIST_POSITION,
        });
        sceneRow.connect('notify::selected', () => {
            if (sceneRow.selected < paths.length) {
                config.scene = paths[sceneRow.selected];
                sceneRow.subtitle = sceneTitle(config.scene);
            }
        });
        group.add(sceneRow);

        const pathRow = new Adw.EntryRow({title: _('Path')});
        pathRow.text = config.scene ?? '';
        pathRow.connect('changed', () => {
            config.scene = pathRow.text;
            const index = paths.indexOf(config.scene);
            if (index >= 0)
                sceneRow.selected = index;
        });
        group.add(pathRow);

        const fpsRow = new Adw.SpinRow({
            title: _('Frame rate'),
            adjustment: new Gtk.Adjustment({
                lower: 1, upper: 240, step_increment: 1, value: config.fps,
            }),
        });
        fpsRow.connect('notify::value', () => {
            config.fps = fpsRow.value;
        });
        group.add(fpsRow);

        const scalingModel = new Gtk.StringList();
        for (const mode of SCALING_MODES)
            scalingModel.append(mode);
        const scalingRow = new Adw.ComboRow({
            title: _('Scaling'),
            model: scalingModel,
            selected: SCALING_MODES.indexOf(config.scaling),
        });
        scalingRow.connect('notify::selected', () => {
            config.scaling = SCALING_MODES[scalingRow.selected] ?? DEFAULT_CONFIG.scaling;
        });
        group.add(scalingRow);

        const keepRow = new Adw.SwitchRow({
            title: _('Below other windows'),
            active: config.keepAtBottom !== false,
        });
        keepRow.connect('notify::active', () => {
            config.keepAtBottom = keepRow.active;
        });
        group.add(keepRow);
    }

    _buildPerMonitorGroup(page, config, scenes, monitorCount) {
        const group = new Adw.PreferencesGroup({title: _('Per monitor')});
        page.add(group);

        const paths = ['', ...scenes.map(scene => scene.path)];

        for (let index = 0; index < monitorCount; index++) {
            const key = String(index);
            const override = config.perMonitor?.[key] ?? {};

            const row = new Adw.ExpanderRow({
                title: `${_('Monitor')} ${index + 1}`,
                subtitle: override.scene ? sceneTitle(override.scene) : _('Default'),
            });

            const model = new Gtk.StringList();
            model.append(_('Default'));
            for (const scene of scenes)
                model.append(`${scene.title} (${scene.id})`);

            const current = override.scene ? paths.indexOf(override.scene) : 0;
            const sceneRow = new Adw.ComboRow({
                title: _('Scene'),
                model,
                selected: current >= 0 ? current : 0,
            });
            sceneRow.connect('notify::selected', () => {
                const path = paths[sceneRow.selected] ?? '';
                config.perMonitor[key] = config.perMonitor[key] ?? {};
                if (path)
                    config.perMonitor[key].scene = path;
                else
                    delete config.perMonitor[key].scene;
                row.subtitle = path ? sceneTitle(path) : _('Default');
            });
            row.add_row(sceneRow);

            const fpsRow = new Adw.SpinRow({
                title: _('Frame rate (0 = default)'),
                adjustment: new Gtk.Adjustment({
                    lower: 0, upper: 240, step_increment: 1, value: override.fps ?? 0,
                }),
            });
            fpsRow.connect('notify::value', () => {
                config.perMonitor[key] = config.perMonitor[key] ?? {};
                if (fpsRow.value > 0)
                    config.perMonitor[key].fps = fpsRow.value;
                else
                    delete config.perMonitor[key].fps;
            });
            row.add_row(fpsRow);

            group.add(row);
        }
    }

    _buildActions(page, config) {
        const group = new Adw.PreferencesGroup();
        page.add(group);

        const applyRow = new Adw.ActionRow({title: _('Save and apply')});
        const applyButton = new Gtk.Button({
            label: _('Apply'),
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        applyButton.connect('clicked', () => {
            saveConfig(config);
            applyExtension();
            applyRow.subtitle = _('Restarting…');
        });
        applyRow.add_suffix(applyButton);
        group.add(applyRow);

        group.add(new Adw.ActionRow({title: _('Config file'), subtitle: CONFIG_PATH}));
    }
}
