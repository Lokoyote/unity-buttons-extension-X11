/**
 * Unity Buttons — GNOME Shell Extension
 *
 * Adds macOS-style window control buttons (close + restore) to the top
 * panel when a window is maximized, alongside the window title. Maximized
 * windows have their WM titlebar hidden to save vertical space. On
 * unmaximize, windows are centered at a user-configured size percentage.
 *
 * All maximize/unmaximize animations are 100% GNOME Shell native.
 * The extension never manipulates actor opacity during max/unmax transitions.
 * A synchronous "poison" technique overwrites Mutter's internal
 * saved_rect so subsequent cycles animate to the correct target.
 *
 * On X11, WM decorations are controlled via _MOTIF_WM_HINTS (xprop).
 * CSD (Client-Side Decorations) vs SSD (Server-Side Decorations) apps
 * are detected and handled differently for correct decoration restore.
 *
 * X11 only. GNOME Shell 46 & 47.
 * License: GPL-3.0-or-later
 */

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main      from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import St      from 'gi://St';
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Gio     from 'gi://Gio';
import Meta    from 'gi://Meta';
import GLib    from 'gi://GLib';

/* ─── Constants ─────────────────────────────────────────────────────── */

/** Desktop-manager windows that must never be tracked. */
const DESKTOP_WM = new Set([
    'ding', 'nemo-desktop', 'nautilus-desktop', 'caja-desktop',
]);

/**
 * GTK3 CSS injected into ~/.config/gtk-3.0/gtk.css to hide the
 * client-side titlebar of LibreOffice when maximized. Uses the specific
 * class signature of LO's CSD window to avoid false positives.
 */
const LO_HACK = `
/* Targets the headerbar inside LibreOffice's maximized CSD window */
window.maximized.background.csd.tiled-top.tiled-bottom.tiled-right.tiled-left > grid > headerbar.titlebar.default-decoration,
window.maximized.background.csd.tiled-top.tiled-bottom.tiled-right.tiled-left > headerbar.titlebar.default-decoration {
    min-height: 0px;
    min-width: 0px;
    margin: 0;
    padding: 0px;
    margin: 0px;
    border: none;
    font-size: 0px;
    opacity: 0;
    background: none;
    box-shadow: none;
    outline: none;
    margin-top: -30px;
}`;

/** Panel button colors (Ubuntu-style). */
const BTN = {
    close:   { n: '#df4a16', h: '#e95420' },
    restore: { n: '#5f5e5a', h: '#7a7974' },
};
const STYLE_BASE = 'border-radius:16px;margin:0 3px;'
                 + 'border:1px solid rgba(0,0,0,.2);transition-duration:150ms;';
const btnStyle = (c) =>
    `background-color:${c};width:16px;height:16px;${STYLE_BASE}`;

/** Global safety timeout (ms) — last-resort cleanup. */
const ANIM_SAFETY_MS = 800;
/** Delay (ms) for xprop subprocess to process decoration changes. */
const DECOR_WAIT_MS  = 150;
/** Position tolerance (px) for rect comparisons. */
const TOLERANCE      = 5;

/* ─── Helpers ───────────────────────────────────────────────────────── */

/**
 * Detects Client-Side Decorations by comparing buffer_rect to frame_rect.
 * CSD apps draw their own shadows, making buffer > frame by several px.
 * Only reliable when the window is NOT maximized (shadows are clipped when max).
 */
const _hasCSD = (win) => {
    try {
        const fr = win.get_frame_rect(), br = win.get_buffer_rect?.();
        if (!fr || !br) return false;
        return (Math.abs(br.width - fr.width) > 4 || Math.abs(br.height - fr.height) > 4);
    } catch (_) { return false; }
};

/** Runs fn inside try/catch, returns result or undefined on error. */
const _safe = (fn) => { try { return fn(); } catch (_) { return undefined; } };

/** Returns true if two rect objects match within TOLERANCE. */
const rectsMatch = (a, b) =>
    Math.abs(a.width  - b.width)  <= TOLERANCE &&
    Math.abs(a.height - b.height) <= TOLERANCE &&
    Math.abs(a.x      - b.x)     <= TOLERANCE &&
    Math.abs(a.y      - b.y)     <= TOLERANCE;

/** Snapshots a Meta.Rectangle into a plain JS object. */
const snapRect = (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height });

/**
 * Per-window state store (WeakMap, auto-GC'd when window is destroyed).
 * All fields are initialized with safe defaults.
 */
const _ws = new WeakMap();
const ws  = (w) => {
    if (!_ws.has(w)) _ws.set(w, {
        tracked: false, wasMax: false, sigs: [],
        animating: false,
        mapTimeoutId: 0, mapHandled: false,
        debounceId: 0,
        preMaxRect: null, nativeUnmax: false, overridePending: false,
        poisoning: false, isCSD: false, wmClass: '',
    });
    return _ws.get(w);
};


/* ═══════════════════════════════════════════════════════════════════════
   PANEL INDICATOR
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * The panel widget that displays close/restore buttons and the window
 * title. Visible only when a NORMAL window is maximized and focused.
 */
const UnityButtons = GObject.registerClass(
class UnityButtons extends PanelMenu.Button {

    _init(settings, ext) {
        super._init(0.0, 'UnityButtons');
        this._s = settings;
        this._ext = ext;
        this.style_class = 'unity-panel-button';
        this.menu.setSensitive(false);
        this.menu.actor.hide();

        this._box = new St.BoxLayout({
            style_class: 'unity-container',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const bb = new St.BoxLayout({
            style_class: 'unity-buttons-box',
            y_align: Clutter.ActorAlign.CENTER,
        });
        bb.add_child(this._mkBtn('close'));
        bb.add_child(this._mkBtn('restore'));
        this._title = new St.Label({
            style_class: 'unity-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(bb);
        this._box.add_child(this._title);
        this.add_child(this._box);

        this._sigs     = [];
        this._safeties = new Set();
        this._titleWin = null;
        this._titleSig = 0;
        this._connectGlobal();
    }

    vfunc_event() { return Clutter.EVENT_PROPAGATE; }

    /** Creates a close or restore button with hover styling. */
    _mkBtn(type) {
        const c = BTN[type];
        const sN = btnStyle(c.n), sH = btnStyle(c.h);
        const btn = new St.Button({
            style: sN, reactive: true, track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        btn.connect('notify::hover', (b) => { b.style = b.hover ? sH : sN; });
        btn.connect('clicked', () => {
            const w = global.display.get_focus_window();
            if (!w) return;
            if (type === 'close')
                w.delete(global.get_current_time());
            else if (w.get_maximized() === Meta.MaximizeFlags.BOTH)
                w.unmaximize(Meta.MaximizeFlags.BOTH);
        });
        return btn;
    }

    /** Registers a signal connection for batch cleanup in destroy(). */
    _sig(obj, signal, fn) {
        this._sigs.push([obj, obj.connect(signal, fn)]);
    }

    /** Registers a safety timeout that auto-removes from the set on fire. */
    _safety(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._safeties.delete(id);
            fn(); return GLib.SOURCE_REMOVE;
        });
        this._safeties.add(id);
    }

    /* ── Global signals ──────────────────────────────────────────────── */

    _connectGlobal() {
        this._sig(global.display, 'notify::focus-window', () => this._refresh());
        this._sig(global.display, 'window-created', (_d, w) =>
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._track(w); return GLib.SOURCE_REMOVE;
            }));
        this._sig(global.workspace_manager, 'active-workspace-changed',
            () => this._refresh());
        this._sig(Main.overview, 'showing', () => {
            this.visible = false; this._ext.updateLayout(false);
        });
        this._sig(Main.overview, 'hidden', () => this._refresh());
        this._sig(global.window_manager, 'map', (_wm, a) => this._onMap(a));
        this._sig(global.window_manager, 'size-change',
            (_wm, a, whichChange, oldFrame, _newFrame) =>
                this._onSizeChange(a, whichChange, oldFrame));
        for (const a of global.get_window_actors()) this._track(a.meta_window);
    }

    /* ── Per-window tracking ─────────────────────────────────────────── */

    /**
     * Starts tracking a window: connects maximization signals, caches
     * wmClass and CSD state. Applies xprop(hide) if already maximized.
     */
    _track(win) {
        if (!win) return;
        const s = ws(win);
        if (s.tracked) return;
        if (win.get_window_type() !== Meta.WindowType.NORMAL) return;
        s.wmClass = (win.get_wm_class() || '').toLowerCase();
        if (DESKTOP_WM.has(s.wmClass)) return;

        s.tracked = true;
        s.wasMax  = win.get_maximized() === Meta.MaximizeFlags.BOTH;

        /* CSD detection: reliable only when not maximized (shadows visible).
         * Default false (SSD) for already-maximized windows — corrected
         * post-unmaximize when detection becomes reliable. */
        s.isCSD = s.wasMax ? false : _hasCSD(win);

        const add = (sig, fn) => s.sigs.push(win.connect(sig, fn));
        add('notify::maximized-horizontally', () => this._onMaxChanged(win));
        add('notify::maximized-vertically',   () => this._onMaxChanged(win));

        /* Track last known non-maximized rect for nativeUnmax optimization. */
        const updatePreMaxRect = () => {
            if (win.get_maximized() || s.animating) return;
            _safe(() => {
                const fr = win.get_frame_rect();
                if (fr.width > 10 && fr.height > 10)
                    s.preMaxRect = snapRect(fr);
            });
        };
        add('size-changed',     updatePreMaxRect);
        add('position-changed', updatePreMaxRect);

        if (s.wasMax) this._ext.applyXprop(win, true);
    }

    /** Disconnects all signals and cleans up timers for a tracked window. */
    _untrack(win) {
        const s = ws(win);
        if (!s.tracked) return;
        for (const id of s.sigs)
            _safe(() => win.disconnect(id));
        if (s.debounceId)   { GLib.source_remove(s.debounceId);   s.debounceId = 0; }
        if (s.mapTimeoutId) { GLib.source_remove(s.mapTimeoutId); s.mapTimeoutId = 0; }
        this._ext._cancelAnim(win);
        _ws.delete(win);
    }

    /* ══════════════════════════════════════════════════════════════════
       SIZE-CHANGE INTERCEPTION
       ══════════════════════════════════════════════════════════════════ */

    /**
     * Synchronous handler for size-change (fires before Mutter moves the actor).
     *
     * MAX: saves pre-maximize rect, lets GNOME animate natively.
     * UNMAX nativeUnmax (preMaxRect ≈ targetRect): lets GNOME animate.
     *   Restores decorations via xprop synchronously so the titlebar is
     *   visible during the native animation.
     * UNMAX override (preMaxRect ≠ targetRect): sets overridePending flag.
     *   A HIGH-priority idle will execute before the next paint frame.
     */
    _onSizeChange(actor, whichChange, oldFrame) {
        const isMax   = whichChange === Meta.SizeChange.MAXIMIZE;
        const isUnmax = whichChange === Meta.SizeChange.UNMAXIMIZE;
        if (!isMax && !isUnmax) return;

        const win = actor?.meta_window;
        if (!win) return;
        const s = ws(win);
        if (!s.tracked || s.poisoning) return;
        /* VLC: excluded from decoration manipulation (known compatibility issue) */
        if (s.wmClass.includes('vlc')) return;

        if (isMax && oldFrame)
            s.preMaxRect = snapRect(oldFrame);
        if (isMax) return;

        const tgt = this._ext._targetRect(win);
        if (s.preMaxRect && tgt && rectsMatch(s.preMaxRect, tgt)) {
            s.nativeUnmax = true;
            /* Restore decorations synchronously: xprop(hide) was applied during
             * MAX. The subprocess needs ~100ms; launching it now means decorations
             * reappear early in GNOME's 250ms animation rather than after. */
            this._ext.applyXprop(win, false);
            this._ext.updateLayout(false);
            return;
        }

        s.nativeUnmax = false;
        s.overridePending = true;
    }

    /* ── Maximize state change dispatch ──────────────────────────────── */

    /**
     * Debounced handler for notify::maximized-* signals.
     * Routes to _doUnmaxOverride (HIGH priority) for overrides,
     * or _processMaxChange (DEFAULT_IDLE) for normal MAX/nativeUnmax.
     */
    _onMaxChanged(win) {
        const s = ws(win);
        if (s.debounceId || s.poisoning) return;

        if (s.overridePending) {
            s.overridePending = false;
            s.debounceId = GLib.idle_add(GLib.PRIORITY_HIGH, () => {
                s.debounceId = 0;
                this._doUnmaxOverride(win);
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        s.debounceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            s.debounceId = 0;
            this._processMaxChange(win);
            return GLib.SOURCE_REMOVE;
        });
    }

    /**
     * UNMAX override — runs at PRIORITY_HIGH before the next Clutter paint.
     *
     * GNOME has configured its animation toward saved_rect (wrong target)
     * but has NOT rendered any frame yet. This handler:
     *   1. Kills GNOME's animation and finalizes Mutter geometry
     *   2. Places the window at targetRect (no frame rendered yet)
     *   3. Detects CSD and restores decorations via xprop
     *   4. Ensures actor is visible and clean
     *   5. Defers a poison cycle so the NEXT MAX→UNMAX is native
     */
    _doUnmaxOverride(win) {
        if (!win) return;
        const s = ws(win);
        if (!s.tracked) return;

        const tgt = this._ext._targetRect(win);
        const actor = win.get_compositor_private?.();
        if (!tgt || !actor) {
            this._ext._cancelAnim(win);
            this._refresh();
            return;
        }

        /* 1. Kill GNOME's animation + finalize Mutter geometry */
        actor.remove_all_transitions();
        _safe(() => global.window_manager.completed_size_change(actor));
        _safe(() => Main.wm._resizing?.delete(actor));
        _safe(() => Main.wm._resizePending?.delete(actor));

        /* 2. Place window at target */
        _safe(() => win.move_resize_frame(true,
            tgt.x, tgt.y, tgt.width, tgt.height));

        /* 3. CSD detection (reliable: window is non-maximized, shadows visible)
         *    + restore decorations */
        const csdNow = _hasCSD(win);
        if (csdNow !== s.isCSD) s.isCSD = csdNow;
        this._ext.applyXprop(win, false);
        this._ext.updateLayout(false);

        /* 4. Ensure actor is clean and visible */
        actor.set_scale(1, 1);
        actor.set_pivot_point(0, 0);
        actor.translation_x = 0;
        actor.translation_y = 0;
        actor.show();
        actor.opacity = 255;

        /* 5. Update internal state */
        s.wasMax = false;
        s.nativeUnmax = false;
        s.preMaxRect = snapRect(tgt);
        s.animating = false;

        this._refresh();
        this._activate(win);

        /* 6. Deferred poison: the NEXT cycle will use native GNOME animation.
         * Wait for Mutter to finalize the move + xprop to process, then run
         * an invisible synchronous max→unmax cycle to overwrite saved_rect. */
        this._ext._defer(DECOR_WAIT_MS, () => {
            if (!win || win.get_maximized()) return;

            const fr = _safe(() => win.get_frame_rect());
            if (fr && !rectsMatch(fr, tgt))
                _safe(() => win.move_resize_frame(true,
                    tgt.x, tgt.y, tgt.width, tgt.height));

            /* Poison: synchronous max→unmax (zero frames between) */
            this._ext._poisonSavedRect(win, s, tgt);

            /* CSD micro-resize to refresh shadows after decoration changes */
            if (s.isCSD && !win.get_maximized()) {
                _safe(() => {
                    const r = win.get_frame_rect();
                    win.move_resize_frame(true, r.x, r.y, r.width - 1, r.height);
                });
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    if (!win || win.get_maximized()) return GLib.SOURCE_REMOVE;
                    _safe(() => {
                        const r = win.get_frame_rect();
                        win.move_resize_frame(true, r.x, r.y, r.width + 1, r.height);
                    });
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        /* Late-enforce for slow apps that re-negotiate size */
        this._ext._defer(400, () => {
            if (!win || win.get_maximized()) return;
            const fr = _safe(() => win.get_frame_rect());
            const tgt2 = this._ext._targetRect(win);
            if (fr && tgt2 && !rectsMatch(fr, tgt2))
                _safe(() => win.move_resize_frame(true,
                    tgt2.x, tgt2.y, tgt2.width, tgt2.height));
        });
    }

    /** Normal MAX/nativeUnmax dispatch. */
    _processMaxChange(win) {
        if (!win) return;
        const s = ws(win);
        if (!s.tracked) return;

        const isMax = win.get_maximized() === Meta.MaximizeFlags.BOTH;
        if (isMax === !!s.wasMax) return;
        s.wasMax = isMax;

        this._refresh();

        if (isMax) {
            /* MAX: GNOME animates natively. xprop(hide) + updateLayout(true)
             * are deferred AFTER the animation to prevent mid-animation
             * decoration removal causing a visible "black flash". */
            s.animating = false;
            this._ext._defer(300, () => {
                if (!win || !win.get_maximized()) return;
                this._ext.applyXprop(win, true);
                this._ext.updateLayout(true);
            });
        } else {
            /* UNMAX nativeUnmax only (override is handled above).
             * xprop(restore) + updateLayout already done in _onSizeChange.
             * Deferred CSD check to correct any false negatives. */
            if (!s.nativeUnmax) return;
            s.animating = false;
            s.nativeUnmax = false;
            s.preMaxRect = null;
            this._ext._defer(DECOR_WAIT_MS + 50, () => {
                if (!win || win.get_maximized()) return;
                const csdNow = _hasCSD(win);
                if (csdNow !== s.isCSD) {
                    s.isCSD = csdNow;
                    this._ext.applyXprop(win, false);
                }
            });
        }
    }

    /* ── Map — initial window centering ──────────────────────────────── */

    /**
     * On window map, intercepts completed_map to prevent the default
     * GNOME animation, hides the actor (opacity=0), then enforces
     * minimum size and centered placement before revealing.
     */
    _onMap(actor) {
        try {
            const win = actor?.meta_window;
            if (!win) return;
            const pct = this._s.get_int('min-open-size-percent');
            if (!pct || pct <= 0) return;
            const s = ws(win);
            if (s.mapHandled || win.get_maximized()) return;
            if (win.get_window_type() !== Meta.WindowType.NORMAL) return;
            if (win.get_transient_for()) return;
            if (DESKTOP_WM.has(s.wmClass)) return;
            if (win.is_skip_taskbar?.() || win.skip_taskbar) return;
            s.mapHandled = true;

            /* Intercept GNOME's map animation:
             * completed_map → _mapDone resets actor state → we force opacity=0.
             * The actor is invisible until _enforceMinSize reveals it. */
            actor.remove_all_transitions();
            global.window_manager.completed_map(actor);
            actor.set_scale(1, 1);
            actor.set_pivot_point(0, 0);
            actor.opacity = 0;

            this._enforceMinSize(win, pct);
        } catch (_) {
            _safe(() => { if (actor) actor.opacity = 255; });
        }
    }

    /**
     * Polls until the window has a valid frame, then moves/resizes it to
     * the centered target. Reveals the actor once placement is done.
     */
    _enforceMinSize(win, pct) {
        const s = ws(win);
        let retries = 0;
        const MAX_RETRIES = 15, POLL_MS = 50;

        const mapDone = () => {
            if (s.mapTimeoutId) { GLib.source_remove(s.mapTimeoutId); s.mapTimeoutId = 0; }
            const a = win?.get_compositor_private();
            if (a) a.opacity = 255;
            this._activate(win);
        };

        const computeTarget = () => {
            const wa = _safe(() => Main.layoutManager.getWorkAreaForMonitor(win.get_monitor()));
            if (!wa || wa.width < 100) return null;
            const r = _safe(() => win.get_frame_rect());
            if (!r) return null;
            const nw = Math.max(r.width,  Math.floor(wa.width  * pct / 100));
            const nh = Math.max(r.height, Math.floor(wa.height * pct / 100));
            return {
                x: wa.x + Math.floor((wa.width  - nw) / 2),
                y: wa.y + Math.floor((wa.height - nh) / 2),
                width: nw, height: nh,
            };
        };

        const poll = () => {
            if (!win) return;
            const r = _safe(() => win.get_frame_rect());
            if (!r || r.width < 10 || r.height < 10) {
                if (++retries >= MAX_RETRIES) { mapDone(); return; }
                s.mapTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
                    s.mapTimeoutId = 0; poll(); return GLib.SOURCE_REMOVE;
                });
                return;
            }
            const tgt = computeTarget();
            if (!tgt || rectsMatch(r, tgt)) { mapDone(); return; }

            _safe(() => win.move_resize_frame(true, tgt.x, tgt.y, tgt.width, tgt.height));
            s.mapTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_MS, () => {
                s.mapTimeoutId = 0;
                mapDone();
                this._ext._defer(200, () => {
                    if (!win || win.get_maximized()) return;
                    const fr = _safe(() => win.get_frame_rect());
                    const tgt2 = computeTarget();
                    if (fr && tgt2 && !rectsMatch(fr, tgt2))
                        _safe(() => win.move_resize_frame(true, tgt2.x, tgt2.y, tgt2.width, tgt2.height));
                });
                return GLib.SOURCE_REMOVE;
            });
        };

        GLib.idle_add(GLib.PRIORITY_HIGH, () => { poll(); return GLib.SOURCE_REMOVE; });
        this._safety(2000, () => {
            if (s.mapTimeoutId) { GLib.source_remove(s.mapTimeoutId); s.mapTimeoutId = 0; }
            const a = win?.get_compositor_private();
            if (a && a.opacity < 255) { a.show(); a.opacity = 255; this._activate(win); }
        });
    }

    /** Focuses the window, with fallback for special window types. */
    _activate(win) {
        if (!win || win.minimized) return;
        _safe(() => Main.activateWindow(win))
            ?? _safe(() => win.activate(global.get_current_time()));
    }

    /* ── Panel visibility ────────────────────────────────────────────── */

    /**
     * Updates the indicator's visibility and the button-layout based on
     * the currently focused window. Always restores button-layout when
     * a non-maximized window gets focus (prevents "stuck hidden buttons"
     * from the previous maximized window).
     */
    _refresh() {
        const win = global.display.get_focus_window();
        if (!win || win.minimized
            || win.get_window_type() !== Meta.WindowType.NORMAL
            || DESKTOP_WM.has(ws(win).wmClass)
            || Main.overview.visible
            || !win.located_on_workspace(
                   global.workspace_manager.get_active_workspace())
            || win.skip_taskbar) {
            this.visible = false;
            this._ext.updateLayout(false);
            this._disconnTitle();
            return;
        }
        const isMax = win.get_maximized() === Meta.MaximizeFlags.BOTH;
        this.visible = isMax;
        if (isMax) this._title.text = win.get_title() || '';

        /* Restore button-layout when a non-max window gets focus.
         * For MAX, handlers call updateLayout AFTER the GNOME animation
         * to prevent mid-animation decoration removal (black flash). */
        if (!isMax)
            this._ext.updateLayout(false);

        if (isMax && win !== this._titleWin) {
            this._disconnTitle();
            this._titleWin = win;
            this._titleSig = win.connect('notify::title', () => {
                if (this.visible) this._title.text = win.get_title() || '';
            });
        } else if (!isMax) {
            this._disconnTitle();
        }
    }

    _disconnTitle() {
        if (this._titleSig && this._titleWin) {
            _safe(() => this._titleWin.disconnect(this._titleSig));
            this._titleSig = 0;
            this._titleWin = null;
        }
    }

    destroy() {
        this._disconnTitle();
        for (const [o, id] of this._sigs)
            _safe(() => o.disconnect(id));
        for (const id of this._safeties)
            _safe(() => GLib.source_remove(id));
        this._safeties.clear();
        for (const a of global.get_window_actors()) {
            if (a.meta_window) this._untrack(a.meta_window);
            if (!a.visible) a.show();
            if (a.opacity < 255) a.opacity = 255;
        }
        super.destroy();
    }
});


/* ═══════════════════════════════════════════════════════════════════════
   EXTENSION MAIN CLASS
   ═══════════════════════════════════════════════════════════════════════ */

export default class UnityButtonsExtension extends Extension {

    enable() {
        if (Meta.is_wayland_compositor())
            throw new Error('Unity Buttons (X11) is not compatible with Wayland sessions.');

        this._settings       = this.getSettings();
        this._wmSettings     = new Gio.Settings({ schema_id: 'org.gnome.desktop.wm.preferences' });
        this._mutterSettings = new Gio.Settings({ schema_id: 'org.gnome.mutter' });
        this._updatingCount  = 0;
        this._deferIds       = new Set();

        /* Layout cache: persists the original button-layout across sessions. */
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'unity-buttons']);
        this._cache = Gio.File.new_for_path(GLib.build_filenamev([dir, 'layout.txt']));
        GLib.mkdir_with_parents(dir, 0o755);

        const cur = this._wmSettings.get_string('button-layout');
        if (cur !== ':') {
            this._layout = cur;
            this._cacheWrite(cur);
            this._settings.set_string('original-layout-cache', cur);
        } else {
            this._layout = this._cacheRead()
                || this._settings.get_string('original-layout-cache')
                || 'close,minimize,maximize:';
        }
        this._wmSigId = this._wmSettings.connect('changed::button-layout', () => {
            if (this._updatingCount) return;
            const v = this._wmSettings.get_string('button-layout');
            if (v && v !== ':') {
                this._layout = v;
                this._settings.set_string('original-layout-cache', v);
                this._cacheWrite(v);
            }
        });

        this._origCenter = this._mutterSettings.get_boolean('center-new-windows');
        this._applyCenter();
        this._minSizeSigId = this._settings.connect(
            'changed::min-open-size-percent', () => this._applyCenter());

        this._applyGtkHack(true);
        this._indicator = new UnityButtons(this._settings, this);
        Main.panel.addToStatusArea('unity-buttons', this._indicator, 0, 'left');
    }

    disable() {
        if (this._wmSigId)      this._wmSettings.disconnect(this._wmSigId);
        if (this._minSizeSigId) this._settings.disconnect(this._minSizeSigId);
        this._mutterSettings.set_boolean('center-new-windows', this._origCenter);
        this._applyGtkHack(false);
        const saved = this._cacheRead()
            || this._settings.get_string('original-layout-cache');
        if (saved && saved !== ':') {
            this._updatingCount++;
            this._wmSettings.set_string('button-layout', saved);
            this._updatingCount--;
        }
        for (const id of this._deferIds)
            _safe(() => GLib.source_remove(id));
        this._deferIds.clear();
        if (this._indicator) { this._indicator.destroy(); this._indicator = null; }
        this._settings = this._wmSettings = this._mutterSettings = null;
    }

    /** Tracked deferred timeout — auto-cleaned at disable(). */
    _defer(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._deferIds.delete(id);
            _safe(fn);
            return GLib.SOURCE_REMOVE;
        });
        this._deferIds.add(id);
        return id;
    }

    _applyCenter() {
        const pct = this._settings.get_int('min-open-size-percent');
        this._mutterSettings.set_boolean('center-new-windows',
            pct > 0 || this._origCenter);
    }

    _getWorkArea(win) {
        return _safe(() => Main.layoutManager.getWorkAreaForMonitor(win.get_monitor()));
    }

    /** Computes the centered target rect based on window-size-percent. */
    _targetRect(win) {
        const wa = this._getWorkArea(win);
        if (!wa) return null;
        const pct = this._settings?.get_int('window-size-percent') || 80;
        const w = Math.min(Math.floor(wa.width  * pct / 100), wa.width);
        const h = Math.min(Math.floor(wa.height * pct / 100), wa.height);
        return {
            x: wa.x + Math.floor((wa.width  - w) / 2),
            y: wa.y + Math.floor((wa.height - h) / 2),
            width: w, height: h,
        };
    }

    /* ═══════════════════════════════════════════════════════════════════
       ANIMATION HELPERS
       ═══════════════════════════════════════════════════════════════════ */

    /** Cancels all pending animations/timers and restores the actor. */
    _cancelAnim(win) {
        const s = ws(win);
        s.animating = false;
        const a = win.get_compositor_private?.();
        if (a) {
            a.remove_all_transitions();
            a.set_scale(1, 1);
            a.set_pivot_point(0, 0);
            a.translation_x = 0;
            a.translation_y = 0;
            a.show();
            a.opacity = 255;
        }
    }

    /**
     * Overwrites Mutter's internal saved_rect by performing a synchronous
     * maximize→suppress→unmaximize→suppress cycle. All calls execute in
     * a single JS tick, so Clutter renders zero intermediate frames.
     *
     * Pre-condition: window is non-maximized and positioned at targetRect.
     * Post-condition: saved_rect = tgt, window at tgt, non-maximized.
     */
    _poisonSavedRect(win, s, tgt) {
        const actor = win.get_compositor_private?.();
        if (!actor || s.poisoning) return;

        s.poisoning = true;

        const suppress = () => {
            actor.remove_all_transitions();
            _safe(() => global.window_manager.completed_size_change(actor));
            _safe(() => Main.wm._resizing?.delete(actor));
            _safe(() => Main.wm._resizePending?.delete(actor));
            actor.set_scale(1, 1);
            actor.set_pivot_point(0, 0);
            actor.opacity = 255;
        };

        try {
            /* maximize → Mutter saves current position (= tgt) as saved_rect */
            win.maximize(Meta.MaximizeFlags.BOTH);
            suppress();
            /* unmaximize → Mutter restores to saved_rect (= tgt) */
            win.unmaximize(Meta.MaximizeFlags.BOTH);
            suppress();
            /* Ensure window is at tgt */
            _safe(() => win.move_resize_frame(true,
                tgt.x, tgt.y, tgt.width, tgt.height));
        } catch (_) {}

        s.poisoning = false;
        s.wasMax = false;
        s.preMaxRect = snapRect(tgt);

        if (s.debounceId) {
            GLib.source_remove(s.debounceId);
            s.debounceId = 0;
        }
    }

    /* ── Layout management ───────────────────────────────────────────── */

    /** Sets button-layout to ':' (hidden) or restores the original. */
    updateLayout(hide) {
        const want = hide ? ':' : this._layout;
        if (this._wmSettings?.get_string('button-layout') !== want) {
            this._updatingCount++;
            this._wmSettings.set_string('button-layout', want);
            this._updatingCount--;
        }
    }

    /* ── X11 decoration control via xprop ────────────────────────────── */

    /**
     * Hides or restores WM decorations using _MOTIF_WM_HINTS.
     * CSD apps: -remove (lets _GTK_FRAME_EXTENTS take over, no double border).
     * SSD apps: -set 2,0,1,0,0 (explicitly requests WM decorations).
     */
    applyXprop(win, hide) {
        if (ws(win).wmClass.includes('vlc')) return;
        let xid;
        _safe(() => { xid = win.get_xwindow(); });
        if (!xid) return;
        const xidHex = '0x' + xid.toString(16);
        const flags = Gio.SubprocessFlags.STDOUT_SILENCE |
                      Gio.SubprocessFlags.STDERR_SILENCE;
        _safe(() => {
            if (hide) {
                Gio.Subprocess.new(
                    ['xprop', '-id', xidHex, '-f', '_MOTIF_WM_HINTS', '32c',
                     '-set', '_MOTIF_WM_HINTS', '2, 0, 0, 0, 0'], flags);
            } else if (ws(win).isCSD) {
                Gio.Subprocess.new(
                    ['xprop', '-id', xidHex, '-remove', '_MOTIF_WM_HINTS'], flags);
            } else {
                Gio.Subprocess.new(
                    ['xprop', '-id', xidHex, '-f', '_MOTIF_WM_HINTS', '32c',
                     '-set', '_MOTIF_WM_HINTS', '2, 0, 1, 0, 0'], flags);
            }
        });
    }

    /* ── Layout cache ────────────────────────────────────────────────── */

    _cacheWrite(s) {
        _safe(() => this._cache.replace_contents(s, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null));
    }
    _cacheRead() {
        return _safe(() => {
            if (!this._cache.query_exists(null)) return null;
            const [ok, d] = this._cache.load_contents(null);
            return ok ? new TextDecoder().decode(d).trim() : null;
        });
    }

    /* ── GTK3 CSS hack for LibreOffice ───────────────────────────────── */

    /**
     * Injects/removes CSS into ~/.config/gtk-3.0/gtk.css to hide the
     * LibreOffice headerbar when maximized. Wrapped in marker comments
     * for clean removal on disable().
     */
    _applyGtkHack(on) {
        _safe(() => {
            const dir = GLib.build_filenamev([GLib.get_user_config_dir(), 'gtk-3.0']);
            GLib.mkdir_with_parents(dir, 0o755);
            const file = Gio.File.new_for_path(GLib.build_filenamev([dir, 'gtk.css']));
            let css = '';
            if (file.query_exists(null)) {
                const [ok, raw] = file.load_contents(null);
                if (ok) css = new TextDecoder().decode(raw);
            }
            css = css.replace(
                /\/\* --- UNITY-HACK --- \*\/[\s\S]*\/\* --- END-UNITY-HACK --- \*\//g, ''
            ).trim();
            if (on) css += '\n\n/* --- UNITY-HACK --- */\n' + LO_HACK + '\n/* --- END-UNITY-HACK --- */';
            file.replace_contents(css.trim(), null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        });
    }
}
