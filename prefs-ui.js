// LWE Wallpaper — 扩展配置面板（GNOME「扩展」应用 → LWE Wallpaper → 齿轮）
// 直接编辑 ~/.config/lwe-wallpaper/config.json，保存后自动重启渲染器。

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';


const CONFIG_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'lwe-wallpaper', 'config.json']);
const WORKSHOP_DEFAULT = '/mnt/windows/Program Files (x86)/Steam/steamapps/workshop/content/431960';
const UUID = 'wallpaperengine@waylandwe';

const DEFAULTS = {
    engine: GLib.build_filenamev([GLib.get_home_dir(), '.local/bin/linux-wallpaperengine']),
    workshop: WORKSHOP_DEFAULT,
    scene: '',
    assets: '/mnt/windows/Program Files (x86)/Steam/steamapps/common/wallpaper_engine/assets',
    fps: 60,
    scaling: 'fill',
    extraArgs: [],
    monitors: [],
    perMonitor: {},
    keepAtBottom: true,
    windowGeometry: null,
};

function loadConfig() {
    const cfg = {...DEFAULTS};
    try {
        const [ok, bytes] = GLib.file_get_contents(CONFIG_PATH);
        if (ok)
            Object.assign(cfg, JSON.parse(new TextDecoder().decode(bytes)));
    } catch (e) {
        logError(e, 'lwe prefs: 读取配置失败');
    }
    return cfg;
}

function saveConfig(cfg) {
    const dir = GLib.path_get_dirname(CONFIG_PATH);
    GLib.mkdir_with_parents(dir, 0o755);
    GLib.file_set_contents(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

function sceneTitle(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(GLib.build_filenamev([path, 'project.json']));
        if (!ok)
            return GLib.path_get_basename(path);
        const d = JSON.parse(new TextDecoder().decode(bytes));
        return d.title ?? GLib.path_get_basename(path);
    } catch {
        return GLib.path_get_basename(path);
    }
}

function listScenes(workshop) {
    const out = [];
    try {
        const dir = Gio.File.new_for_path(workshop);
        const e = dir.enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = e.next_file(null))) {
            if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                continue;
            const id = info.get_name();
            const path = GLib.build_filenamev([workshop, id]);
            if (GLib.file_test(GLib.build_filenamev([path, 'project.json']), GLib.FileTest.EXISTS))
                out.push({id, path, title: sceneTitle(path)});
        }
    } catch (e) {
        logError(e, 'lwe prefs: 扫描工坊失败');
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
}

function monitorCount() {
    try {
        const display = Gdk.Display.get_default();
        return display ? display.get_n_monitors() : 2;
    } catch {
        return 2;
    }
}

function applySettings() {
    // 通过 D-Bus 让 shell 重启扩展（等价于 disable → enable）
    Gio.DBus.session.call('org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions',
        'org.gnome.Shell.Extensions', 'DisableExtension',
        new GLib.Variant('(s)', [UUID]), null, Gio.DBusCallFlags.NONE, -1, null, null);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
        Gio.DBus.session.call('org.gnome.Shell.Extensions', '/org/gnome/Shell/Extensions',
            'org.gnome.Shell.Extensions', 'EnableExtension',
            new GLib.Variant('(s)', [UUID]), null, Gio.DBusCallFlags.NONE, -1, null, null);
        return GLib.SOURCE_REMOVE;
    });
}


export function fillPreferencesWindow(window) {
        const cfg = loadConfig();
        const scenes = listScenes(cfg.workshop);
        const nMon = Math.max(1, monitorCount());

        // ---------------------------------------------------------- 常规
        const page = new Adw.PreferencesPage({
            title: '壁纸',
            icon_name: 'preferences-desktop-wallpaper-symbolic',
        });
        window.add(page);

        const general = new Adw.PreferencesGroup({
            title: '默认场景',
            description: '所有显示器都用这个场景；下面可以给单块屏单独覆盖',
        });
        page.add(general);

        // 场景下拉
        const sceneModel = new Gtk.StringList();
        const paths = [];
        for (const s of scenes) {
            sceneModel.append(`${s.title}  (${s.id})`);
            paths.push(s.path);
        }
        let curIdx = paths.indexOf(cfg.scene);
        const sceneRow = new Adw.ComboRow({
            title: '场景',
            subtitle: cfg.scene ? sceneTitle(cfg.scene) : '未选择',
            model: sceneModel,
            selected: curIdx >= 0 ? curIdx : Gtk.INVALID_LIST_POSITION,
        });
        sceneRow.connect('notify::selected', () => {
            const i = sceneRow.selected;
            if (i >= 0 && i < paths.length) {
                cfg.scene = paths[i];
                sceneRow.subtitle = sceneTitle(paths[i]);
            }
        });
        general.add(sceneRow);

        // 手动路径
        const pathRow = new Adw.EntryRow({title: '或直接填场景目录 / project.json 路径'});
        pathRow.text = cfg.scene ?? '';
        pathRow.connect('changed', () => {
            if (pathRow.text) {
                cfg.scene = pathRow.text;
                const i = paths.indexOf(pathRow.text);
                if (i >= 0)
                    sceneRow.selected = i;
            }
        });
        general.add(pathRow);

        // fps / 缩放
        const fpsRow = new Adw.SpinRow({
            title: '帧率',
            subtitle: '30 更省电，60 更顺滑',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 240, step_increment: 1, value: cfg.fps}),
        });
        fpsRow.connect('notify::value', () => {
            cfg.fps = fpsRow.value;
        });
        general.add(fpsRow);

        const scalingModel = new Gtk.StringList();
        ['fill', 'fit', 'stretch'].forEach(s => scalingModel.append(s));
        const scalingRow = new Adw.ComboRow({
            title: '缩放方式',
            subtitle: 'fill 铺满（裁切）· fit 完整显示（留黑边）· stretch 拉伸',
            model: scalingModel,
            selected: ['fill', 'fit', 'stretch'].indexOf(cfg.scaling),
        });
        scalingRow.connect('notify::selected', () => {
            cfg.scaling = ['fill', 'fit', 'stretch'][scalingRow.selected] ?? 'fill';
        });
        general.add(scalingRow);

        const keepRow = new Adw.SwitchRow({
            title: '把渲染窗口压在窗口栈底层',
            subtitle: '关闭后渲染窗口可能盖住应用窗口（一般不关）',
            active: cfg.keepAtBottom !== false,
        });
        keepRow.connect('notify::active', () => {
            cfg.keepAtBottom = keepRow.active;
        });
        general.add(keepRow);

        // ---------------------------------------------------------- 每屏
        const perPage = new Adw.PreferencesGroup({
            title: '按显示器单独设置',
            description: '留空表示跟随上面的默认场景',
        });
        page.add(perPage);

        for (let i = 0; i < nMon; i++) {
            const key = String(i);
            const over = cfg.perMonitor?.[key] ?? {};

            const row = new Adw.ExpanderRow({
                title: `显示器 ${i}${i === 0 ? '（通常是主屏）' : ''}`,
                subtitle: over.scene ? sceneTitle(over.scene) : '跟随默认',
            });

            const mModel = new Gtk.StringList();
            mModel.append('跟随默认');
            for (const s of scenes)
                mModel.append(`${s.title}  (${s.id})`);
            const mPaths = [''].concat(paths);
            const sel = over.scene ? mPaths.indexOf(over.scene) : 0;
            const mRow = new Adw.ComboRow({
                title: '场景',
                model: mModel,
                selected: sel >= 0 ? sel : 0,
            });
            mRow.connect('notify::selected', () => {
                const p = mPaths[mRow.selected] ?? '';
                cfg.perMonitor = cfg.perMonitor ?? {};
                cfg.perMonitor[key] = cfg.perMonitor[key] ?? {};
                if (p)
                    cfg.perMonitor[key].scene = p;
                else
                    delete cfg.perMonitor[key].scene;
                row.subtitle = p ? sceneTitle(p) : '跟随默认';
            });
            row.add_row(mRow);

            const mFps = new Adw.SpinRow({
                title: '帧率（0 = 跟随默认）',
                adjustment: new Gtk.Adjustment({lower: 0, upper: 240, step_increment: 1, value: over.fps ?? 0}),
            });
            mFps.connect('notify::value', () => {
                cfg.perMonitor = cfg.perMonitor ?? {};
                cfg.perMonitor[key] = cfg.perMonitor[key] ?? {};
                if (mFps.value > 0)
                    cfg.perMonitor[key].fps = mFps.value;
                else
                    delete cfg.perMonitor[key].fps;
            });
            row.add_row(mFps);

            perPage.add(row);
        }

        // ---------------------------------------------------------- 保存
        const actionGroup = new Adw.PreferencesGroup();
        page.add(actionGroup);

        const applyRow = new Adw.ActionRow({
            title: '保存并应用',
            subtitle: '写入配置并重启渲染器（无需注销）',
        });
        const applyBtn = new Gtk.Button({
            label: '应用',
            valign: Gtk.Align.CENTER,
            css_classes: ['suggested-action'],
        });
        applyBtn.connect('clicked', () => {
            saveConfig(cfg);
            applySettings();
            applyRow.subtitle = '已保存，正在重启渲染器…';
        });
        applyRow.add_suffix(applyBtn);
        actionGroup.add(applyRow);

        const openRow = new Adw.ActionRow({
            title: '配置文件位置',
            subtitle: CONFIG_PATH,
        });
        actionGroup.add(openRow);
    }
