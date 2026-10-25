/**
 * Placeholder cl_ui_* / cl_model_* for `pio run -e stub`.
 *
 * Lets the HAL, Wi-Fi, portal, discovery and pairing be brought up on real
 * hardware without packages/lvgl-ui. Screens are plain LVGL labels/buttons;
 * the snapshot "parser" only checks that the body looks like JSON.
 * Not compiled into the real firmware (CLAUDETTE_STUB_UI is only set by [env:stub]).
 */
#ifdef CLAUDETTE_STUB_UI

#include <stdio.h>
#include <string.h>

#include "cl_model.h"
#include "cl_ui.h"

static const cl_platform_t *s_pf;
static lv_obj_t *s_scr;
static void (*s_action)(void *);
static void *s_action_user;
static cl_link_t s_link = CL_LINK_STALE;
static uint32_t s_age;
static cl_snapshot_t s_snap;
static bool s_on_dash;
static lv_obj_t *s_dash_status;
static lv_obj_t *s_dash_body;

#define COL_BG lv_color_hex(0x1B2333)
#define COL_FG lv_color_hex(0xF5EBDD)
#define COL_ACC lv_color_hex(0xD97757)

static lv_obj_t *new_screen(const char *title) {
    lv_obj_t *scr = lv_obj_create(NULL);
    lv_obj_set_style_bg_color(scr, COL_BG, 0);
    lv_obj_set_style_text_color(scr, COL_FG, 0);
    lv_obj_set_style_pad_all(scr, 16, 0);
    lv_obj_set_flex_flow(scr, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(scr, 12, 0);

    lv_obj_t *t = lv_label_create(scr);
    lv_obj_set_style_text_font(t, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(t, COL_ACC, 0);
    lv_label_set_text(t, title ? title : "");
    lv_obj_set_width(t, LV_PCT(100));
    lv_label_set_long_mode(t, LV_LABEL_LONG_WRAP);

    lv_obj_t *old = s_scr;
    s_scr = scr;
    lv_screen_load(scr);
    if (old) lv_obj_delete(old);
    s_on_dash = false;
    return scr;
}

static lv_obj_t *add_text(lv_obj_t *parent, const char *text) {
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_width(l, LV_PCT(100));
    lv_label_set_long_mode(l, LV_LABEL_LONG_WRAP);
    lv_label_set_text(l, text ? text : "");
    return l;
}

static void action_cb(lv_event_t *e) {
    (void)e;
    if (s_action) s_action(s_action_user);
}

static void host_cb(lv_event_t *e) {
    uint8_t idx = (uint8_t)(uintptr_t)lv_event_get_user_data(e);
    if (s_pf && s_pf->select_host) s_pf->select_host(idx, s_pf->user);
}

static void reconnect_cb(lv_event_t *e) {
    (void)e;
    if (s_pf && s_pf->reconnect) s_pf->reconnect(s_pf->user);
}

static lv_obj_t *add_button(lv_obj_t *parent, const char *label, lv_event_cb_t cb, void *user) {
    lv_obj_t *b = lv_button_create(parent);
    lv_obj_set_width(b, LV_PCT(100));
    lv_obj_set_style_bg_color(b, COL_ACC, 0);
    lv_obj_add_event_cb(b, cb, LV_EVENT_CLICKED, user);
    lv_obj_t *l = lv_label_create(b);
    lv_label_set_text(l, label);
    lv_obj_set_style_text_color(l, COL_BG, 0);
    lv_obj_center(l);
    return b;
}

static void render_dashboard(void) {
    if (!s_on_dash) return;
    static const char *link_names[] = {"live", "stale", "offline"};
    char buf[96];
    snprintf(buf, sizeof(buf), "Link: %s (%lus)", link_names[s_link], (unsigned long)s_age);
    lv_label_set_text(s_dash_status, buf);

    char body[1024];
    size_t n = 0;
    body[0] = '\0';
    if (!s_snap.valid) {
        n += snprintf(body + n, sizeof(body) - n, "No snapshot yet");
    } else {
        n += snprintf(body + n, sizeof(body) - n, "%s: %u session(s)\n", s_snap.host_name,
                      (unsigned)s_snap.session_count);
        for (uint8_t i = 0; i < s_snap.session_count && n < sizeof(body) - 64; i++) {
            n += snprintf(body + n, sizeof(body) - n, "%s %s - %s\n", s_snap.sessions[i].pinned ? "*" : "-",
                          s_snap.sessions[i].name, cl_state_label(s_snap.sessions[i].state));
        }
    }
    lv_label_set_text(s_dash_body, body);
}

/* ------------------------------------------------------------------ cl_ui */

/* The stub screens are portrait-only; rotation is accepted and ignored. */
void cl_ui_set_rotation(uint8_t quarter_turns) { (void)quarter_turns; }

uint8_t *cl_ui_rotate_flush(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map, uint8_t *rot_buf,
                            lv_area_t *out_area) {
    (void)disp;
    (void)rot_buf;
    *out_area = *area;
    return px_map;
}

void cl_ui_init(const cl_platform_t *platform) {
    s_pf = platform;
    new_screen("Claudette (stub UI)");
}

void cl_ui_show_dashboard(void) {
    lv_obj_t *scr = new_screen("Claudette (stub UI)");
    s_dash_status = add_text(scr, "");
    s_dash_body = add_text(scr, "");
    add_button(scr, "Reconnect", reconnect_cb, NULL);
    s_on_dash = true;
    render_dashboard();
}

void cl_ui_set_snapshot(const cl_snapshot_t *snap) {
    if (snap != &s_snap) s_snap = *snap;
    render_dashboard();
}

void cl_ui_set_link(cl_link_t link, uint32_t last_ok_age_s) {
    if (link == s_link && last_ok_age_s == s_age) return;
    s_link = link;
    s_age = last_ok_age_s;
    render_dashboard();
}

void cl_ui_set_device_info(const cl_device_info_t *info) { (void)info; }

void cl_ui_show_wifi_setup(const char *ap_name, const char *ap_password, const char *portal_url) {
    lv_obj_t *scr = new_screen("Wi-Fi setup");
    char buf[200];
    snprintf(buf, sizeof(buf), "Join Wi-Fi:\n%s\n\nPassword:\n%s\n\nThen open %s", ap_name, ap_password,
             portal_url);
    add_text(scr, buf);
#if LV_USE_QRCODE
    char qr[160];
    snprintf(qr, sizeof(qr), "WIFI:T:WPA;S:%s;P:%s;;", ap_name, ap_password);
    lv_obj_t *code = lv_qrcode_create(scr);
    lv_qrcode_set_size(code, 140);
    lv_qrcode_set_dark_color(code, lv_color_black());
    lv_qrcode_set_light_color(code, lv_color_white());
    lv_qrcode_update(code, qr, (uint32_t)strlen(qr));
#endif
}

void cl_ui_show_progress(const char *title, const char *detail) {
    lv_obj_t *scr = new_screen(title);
    add_text(scr, detail);
}

void cl_ui_show_host_picker(const char *const *hosts, uint8_t count, const char *hint) {
    lv_obj_t *scr = new_screen(count ? "Pick your Mac" : "Searching...");
    add_text(scr, hint);
    for (uint8_t i = 0; i < count; i++) add_button(scr, hosts[i], host_cb, (void *)(uintptr_t)i);
}

void cl_ui_show_pairing(const char *host_name, const char *code) {
    lv_obj_t *scr = new_screen("Pair with your Mac");
    char buf[120];
    snprintf(buf, sizeof(buf), "Type this code into Claudette on %s:", host_name);
    add_text(scr, buf);
    lv_obj_t *c = add_text(scr, code);
    lv_obj_set_style_text_font(c, &lv_font_montserrat_20, 0);
    lv_obj_set_style_text_color(c, COL_ACC, 0);
}

void cl_ui_show_message(const char *title, const char *body, const char *action_label,
                        void (*on_action)(void *user), void *user) {
    lv_obj_t *scr = new_screen(title);
    add_text(scr, body);
    s_action = on_action;
    s_action_user = user;
    if (action_label && on_action) add_button(scr, action_label, action_cb, NULL);
}

/* --------------------------------------------------------------- cl_model */

bool cl_model_parse(const char *json, size_t len, cl_snapshot_t *out) {
    memset(out, 0, sizeof(*out));
    while (len && (*json == ' ' || *json == '\n' || *json == '\r' || *json == '\t')) {
        json++;
        len--;
    }
    out->valid = len > 1 && json[0] == '{';
    strcpy(out->host_name, "Mac (stub parser)");
    out->daily_tokens = CL_UNKNOWN;
    return out->valid;
}

bool cl_parse_iso8601(const char *s, size_t len, int64_t *out_epoch_s) {
    (void)s;
    (void)len;
    *out_epoch_s = 0;
    return false;
}

void cl_copy_utf8(char *dst, size_t size, const char *src, size_t src_len) {
    if (!size) return;
    size_t n = src_len < size - 1 ? src_len : size - 1;
    while (n > 0 && n < src_len && ((unsigned char)src[n] & 0xC0) == 0x80) n--;
    memcpy(dst, src, n);
    dst[n] = '\0';
}

const char *cl_state_label(cl_state_t s) {
    switch (s) {
        case CL_STATE_WORKING: return "Working";
        case CL_STATE_NEEDS_ATTENTION: return "Needs you";
        case CL_STATE_READY: return "Ready";
        case CL_STATE_FAILED: return "Error";
        case CL_STATE_STOPPED: return "Stopped";
        default: return "Unknown";
    }
}

#endif /* CLAUDETTE_STUB_UI */
