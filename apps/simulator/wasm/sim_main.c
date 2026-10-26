/**
 * Browser runtime for the shared Claudette UI. The JS shell drives time and
 * input, feeds snapshots, and blits the RGBA framebuffer to a <canvas>.
 * Rendering is RGB565, exactly like the ESP32 panel.
 */
#include <emscripten.h>
#include <stdlib.h>
#include <string.h>

#include "cl_model.h"
#include "cl_ui.h"
#include "lvgl.h"

#define W CL_SCREEN_W
#define H CL_SCREEN_H
#define BUF_LINES 60

static uint8_t rgba[W * H * 4];
static uint16_t draw_buf[W * BUF_LINES];
static uint16_t rot_buf[W * BUF_LINES];
static uint32_t now_ms;
static int dirty = 1;
static int ptr_x, ptr_y, ptr_down, ptr_latched;
static cl_snapshot_t scratch;

EM_JS(void, js_platform, (const char *event, const char *arg, int num), {
    if (Module.onPlatform) Module.onPlatform(UTF8ToString(event), arg ? UTF8ToString(arg) : "", num);
});

static uint32_t tick_cb(void) { return now_ms; }

static void flush_cb(lv_display_t *disp, const lv_area_t *logical, uint8_t *px_map)
{
    /* Same rotation path as the firmware: the framebuffer is always the physical 320x480 panel. */
    lv_area_t panel;
    const uint16_t *src = (const uint16_t *)cl_ui_rotate_flush(disp, logical, px_map, (uint8_t *)rot_buf, &panel);
    const lv_area_t *area = &panel;
    for (int32_t y = area->y1; y <= area->y2; y++) {
        uint8_t *dst = &rgba[(y * W + area->x1) * 4];
        for (int32_t x = area->x1; x <= area->x2; x++) {
            uint16_t c = *src++;
            uint8_t r = (c >> 11) & 0x1F, g = (c >> 5) & 0x3F, b = c & 0x1F;
            *dst++ = (uint8_t)((r << 3) | (r >> 2));
            *dst++ = (uint8_t)((g << 2) | (g >> 4));
            *dst++ = (uint8_t)((b << 3) | (b >> 2));
            *dst++ = 255;
        }
    }
    dirty = 1;
    lv_display_flush_ready(disp);
}

static void read_cb(lv_indev_t *indev, lv_indev_data_t *data)
{
    (void)indev;
    data->point.x = ptr_x;
    data->point.y = ptr_y;
    /* A tap shorter than one input poll still counts as a press. */
    data->state = (ptr_down || ptr_latched) ? LV_INDEV_STATE_PRESSED : LV_INDEV_STATE_RELEASED;
    ptr_latched = 0;
}

static void on_toggle_pin(const char *id, bool pinned, void *u) { (void)u; js_platform("toggle_pin", id, pinned); }
static void on_brightness(uint8_t pct, void *u) { (void)u; js_platform("brightness", NULL, pct); }
static void on_motion(bool reduce, void *u) { (void)u; js_platform("reduce_motion", NULL, reduce); }
static void on_select_host(uint8_t i, void *u) { (void)u; js_platform("select_host", NULL, i); }
static void on_reconnect(void *u) { (void)u; js_platform("reconnect", NULL, 0); }
static void on_forget(void *u) { (void)u; js_platform("forget_host", NULL, 0); }
static void on_reset(void *u) { (void)u; js_platform("factory_reset", NULL, 0); }
static void on_layout(bool tiles, void *u) { (void)u; js_platform("layout", NULL, tiles); }
static void on_rotation(uint8_t q, void *u) { (void)u; js_platform("rotation", NULL, q); }
static void on_message_action(void *u) { (void)u; js_platform("message_action", NULL, 0); }

EMSCRIPTEN_KEEPALIVE uint8_t *sim_framebuffer(void) { return rgba; }

EMSCRIPTEN_KEEPALIVE void sim_init(uint32_t start_ms)
{
    now_ms = start_ms;
    lv_init();
    lv_tick_set_cb(tick_cb);
    lv_display_t *disp = lv_display_create(W, H);
    lv_display_set_color_format(disp, LV_COLOR_FORMAT_RGB565);
    lv_display_set_buffers(disp, draw_buf, NULL, sizeof(draw_buf), LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_flush_cb(disp, flush_cb);
    lv_indev_t *indev = lv_indev_create();
    lv_indev_set_type(indev, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(indev, read_cb);

    static const cl_platform_t plat = {
        .toggle_pin = on_toggle_pin,
        .set_brightness = on_brightness,
        .set_reduce_motion = on_motion,
        .select_host = on_select_host,
        .reconnect = on_reconnect,
        .forget_host = on_forget,
        .factory_reset = on_reset,
        .set_layout = on_layout,
        .set_rotation = on_rotation,
    };
    cl_ui_init(&plat);
    cl_ui_show_dashboard();
}

/** Advance time and render. Returns 1 when the framebuffer changed. */
EMSCRIPTEN_KEEPALIVE int sim_tick(uint32_t ms)
{
    now_ms = ms;
    lv_timer_handler();
    int was = dirty;
    dirty = 0;
    return was;
}

EMSCRIPTEN_KEEPALIVE void sim_pointer(int x, int y, int down)
{
    ptr_x = x;
    ptr_y = y;
    if (down && !ptr_down) ptr_latched = 1;
    ptr_down = down;
}

EMSCRIPTEN_KEEPALIVE int sim_set_snapshot(const char *json, int len)
{
    if (!cl_model_parse(json, (size_t)len, &scratch)) return 0;
    cl_ui_set_snapshot(&scratch);
    return 1;
}

EMSCRIPTEN_KEEPALIVE void sim_set_link(int link, int last_ok_age_s) { cl_ui_set_link((cl_link_t)link, (uint32_t)last_ok_age_s); }

EMSCRIPTEN_KEEPALIVE void sim_set_device(int brightness, int reduce_motion, const char *host, const char *mode, int tiles,
                                         int rotation)
{
    cl_device_info_t info = {
        .firmware_version = "sim-0.1.0",
        .wifi_ssid = "",
        .ip = mode,
        .rssi = 0,
        .host_label = host,
        .brightness = (uint8_t)brightness,
        .reduce_motion = reduce_motion != 0,
        .is_simulator = true,
        .tiles = tiles != 0,
        .rotation = (uint8_t)rotation,
    };
    cl_ui_set_device_info(&info);
}

EMSCRIPTEN_KEEPALIVE void sim_show_dashboard(void) { cl_ui_show_dashboard(); }

EMSCRIPTEN_KEEPALIVE void sim_show_wifi(const char *ap, const char *pw, const char *url) { cl_ui_show_wifi_setup(ap, pw, url); }

EMSCRIPTEN_KEEPALIVE void sim_show_progress(const char *title, const char *detail) { cl_ui_show_progress(title, detail); }

/** hosts: newline-separated names. */
EMSCRIPTEN_KEEPALIVE void sim_show_hosts(const char *hosts, const char *hint)
{
    static char buf[256];
    const char *list[6];
    uint8_t n = 0;
    strncpy(buf, hosts, sizeof(buf) - 1);
    for (char *p = buf; *p && n < 6;) {
        list[n++] = p;
        char *nl = strchr(p, '\n');
        if (!nl) break;
        *nl = '\0';
        p = nl + 1;
    }
    cl_ui_show_host_picker(list, n, hint);
}

EMSCRIPTEN_KEEPALIVE void sim_show_pairing(const char *host, const char *code) { cl_ui_show_pairing(host, code); }

EMSCRIPTEN_KEEPALIVE void sim_show_message(const char *title, const char *body, const char *action)
{
    cl_ui_show_message(title, body, action, on_message_action, NULL);
}

#include "lvgl_private.h"
#include <stdio.h>
/** Debug helper: describe the widget under a point (used by tests). */
EMSCRIPTEN_KEEPALIVE const char *sim_debug_hit(int x, int y)
{
    static char out[256];
    lv_point_t p = {x, y};
    lv_obj_t *o = lv_indev_search_obj(lv_screen_active(), &p);
    size_t n = 0;
    lv_display_t *disp = lv_display_get_default();
    n += (size_t)snprintf(out, sizeof(out), "[act=%p loading=%p children=%u] ", (void *)lv_screen_active(),
                          (void *)lv_display_get_screen_loading(disp), (unsigned)lv_obj_get_child_count(lv_screen_active()));
    for (int depth = 0; o && depth < 8 && n < sizeof(out) - 40; depth++, o = lv_obj_get_parent(o))
        n += (size_t)snprintf(out + n, sizeof(out) - n, "%s%s(clk=%d)", depth ? " < " : "", o->class_p->name ? o->class_p->name : "?",
                              lv_obj_has_flag(o, LV_OBJ_FLAG_CLICKABLE));
    return out;
}

#include "cl_mascot.h"
/** Debug helper: the look the device picks for a seed, as "body,headwear,accent,extra". */
EMSCRIPTEN_KEEPALIVE const char *sim_debug_look(const char *seed)
{
    static char out[32];
    cl_look_t l = cl_look_for(seed);
    snprintf(out, sizeof(out), "%u,%u,%u,%u", l.body, l.headwear, l.accent, l.extra);
    return out;
}

#include <malloc.h>
/** Debug helper: bytes currently allocated on the C heap (for leak checks). */
EMSCRIPTEN_KEEPALIVE int sim_debug_heap(void) { return (int)mallinfo().uordblks; }
