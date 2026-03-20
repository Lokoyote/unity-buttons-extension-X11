/**
 * Unity Buttons — Preferences Window
 *
 * - Unmaximize size: SpinButton with live window resize preview
 * - Minimum open size: enforce a floor on new maximizable windows
 */
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class UnityButtonsPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Unity Buttons',
            icon_name: 'dialog-information-symbolic',
        });
        window.add(page);

        // ── Detect primary monitor size ─────────────────────────────────
        let scrW = 1920, scrH = 1080;
        try {
            const disp = Gdk.Display.get_default();
            if (disp) {
                const mons = disp.get_monitors();
                if (mons?.get_n_items() > 0) {
                    const g = mons.get_item(0).get_geometry();
                    scrW = g.width;
                    scrH = g.height;
                }
            }
        } catch(_) {}

        // =================================================================
        // GROUP 1 — Unmaximize size
        // =================================================================
        const g1 = new Adw.PreferencesGroup({
            title: 'Taille du unmaximize',
            description: 'Changez la valeur — la fenêtre se redimensionne en temps réel',
        });
        page.add(g1);

        const unmaxRow = new Adw.ActionRow({
            title: 'Taille maximale (%)',
            subtitle: 'Les fenêtres plus grandes sont réduites au unmaximize',
        });

        const unmaxAdj = new Gtk.Adjustment({
            lower: 50, upper: 95, step_increment: 5, page_increment: 10,
            value: s.get_int('window-size-percent'),
        });
        const unmaxSpin = new Gtk.SpinButton({
            adjustment: unmaxAdj,
            numeric: true,
            climb_rate: 5,
            valign: Gtk.Align.CENTER,
        });

        const unmaxInfo = new Adw.ActionRow({ sensitive: false });

        const previewUnmax = (pct) => {
            const w = Math.floor(scrW * pct / 100);
            const h = Math.floor(scrH * pct / 100);
            unmaxInfo.set_title(`${pct} %  →  ${w} × ${h} px`);
            unmaxInfo.set_subtitle(`sur votre écran ${scrW} × ${scrH}`);

            // Live resize preview (grow AND shrink)
            window.set_default_size(w, h);
            window.set_size_request(w, h);
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                window.set_size_request(-1, -1);
                return GLib.SOURCE_REMOVE;
            });
        };

        unmaxSpin.connect('value-changed', sp => {
            const v = sp.get_value_as_int();
            s.set_int('window-size-percent', v);
            previewUnmax(v);
        });

        unmaxRow.add_suffix(unmaxSpin);
        g1.add(unmaxRow);
        g1.add(unmaxInfo);

        // Initial preview on next idle (after window is realized)
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            previewUnmax(s.get_int('window-size-percent'));
            return GLib.SOURCE_REMOVE;
        });

        const tipRow = new Adw.ActionRow({
            title: 'Info',
            subtitle: 'Les petites fenêtres gardent leur taille originale même sous cette limite',
        });
        tipRow.set_sensitive(false);
        g1.add(tipRow);

        // =================================================================
        // GROUP 2 — Minimum open size
        // =================================================================
        const g2 = new Adw.PreferencesGroup({
            title: 'Taille minimale d\'ouverture',
            description: 'Les fenêtres maximisables trop petites seront agrandies et centrées',
        });
        page.add(g2);

        const curMin = s.get_int('min-open-size-percent');

        const minSwitch = new Adw.SwitchRow({
            title: 'Appliquer une taille minimale',
            subtitle: 'Pour les nouvelles fenêtres qui ont un bouton maximiser',
        });
        minSwitch.set_active(curMin > 0);
        g2.add(minSwitch);

        const minRow = new Adw.ActionRow({ title: 'Taille minimale (%)' });
        const minAdj = new Gtk.Adjustment({
            lower: 30, upper: 90, step_increment: 5, page_increment: 10,
            value: curMin > 0 ? curMin : 50,
        });
        const minSpin = new Gtk.SpinButton({
            adjustment: minAdj,
            numeric: true,
            climb_rate: 5,
            valign: Gtk.Align.CENTER,
        });

        const minInfo = new Adw.ActionRow({ sensitive: false });

        const refreshMin = () => {
            const on  = minSwitch.get_active();
            const pct = minSpin.get_value_as_int();
            s.set_int('min-open-size-percent', on ? pct : 0);
            minRow.set_sensitive(on);
            if (on) {
                const w = Math.floor(scrW * pct / 100);
                const h = Math.floor(scrH * pct / 100);
                minInfo.set_title(`${pct} %  →  min ${w} × ${h} px`);
                minInfo.set_subtitle('Les fenêtres plus petites seront redimensionnées à l\'ouverture');
            } else {
                minInfo.set_title('Désactivé');
                minInfo.set_subtitle('Les fenêtres s\'ouvrent à leur taille par défaut');
            }
        };

        minSwitch.connect('notify::active', refreshMin);
        minSpin.connect('value-changed', refreshMin);

        minRow.add_suffix(minSpin);
        g2.add(minRow);
        g2.add(minInfo);
        refreshMin();

        // =================================================================
        // GROUP 3 — About
        // =================================================================
        const g3 = new Adw.PreferencesGroup({ title: 'À propos' });
        page.add(g3);
        g3.add(new Adw.ActionRow({
            title: 'Unity Buttons',
            subtitle: 'Boutons macOS dans le panneau avec centrage intelligent des fenêtres',
        }));
    }
}
