/**
 * Claudette shared LVGL UI.
 *
 * One UI, two runtimes: this code is compiled into the ESP32-S3 firmware and
 * into the WebAssembly browser simulator. It only draws; everything that talks
 * to hardware or the network lives behind cl_platform_t callbacks.
 *
 * Threading: call every cl_ui_* function from the thread that runs
 * lv_timer_handler(). Strings passed in are copied.
 */
#ifndef CL_UI_H
#define CL_UI_H

#include "cl_model.h"
#include "lvgl.h"

#ifdef __cplusplus
extern "C" {
#endif

#define CL_SCREEN_W 320
#define CL_SCREEN_H 480

typedef enum {
    CL_LINK_LIVE = 0,  /* fresh data */
    CL_LINK_STALE,     /* last poll failed recently; show values dimmed with age */
    CL_LINK_OFFLINE,   /* ~15 s without a good snapshot: "Sleeping" */
} cl_link_t;

typedef struct {
    /** Long-press on a session: Claudette-only favourite (never Claude's native pin). */
    void (*toggle_pin)(const char *session_id, bool pinned, void *user);
    void (*set_brightness)(uint8_t percent, void *user);
    void (*set_reduce_motion)(bool reduce, void *user);
    /** Index into the list given to cl_ui_show_host_picker(). */
    void (*select_host)(uint8_t index, void *user);
    void (*reconnect)(void *user);
    /** Forget the paired host and start discovery/pairing again. */
    void (*forget_host)(void *user);
    /** Wipe Wi-Fi + pairing and reboot into setup. */
    void (*factory_reset)(void *user);
    /** Home layout changed: list (false) or tile grid (true). Persist it and pass it back in cl_device_info_t. */
    void (*set_layout)(bool tiles, void *user);
    void *user;
} cl_platform_t;

typedef struct {
    const char *firmware_version;
    const char *wifi_ssid;   /* NULL/"" when not connected */
    const char *ip;
    int8_t rssi;             /* dBm, 0 when unknown */
    const char *host_label;  /* paired host's display name and address */
    uint8_t brightness;      /* 5..100 */
    bool reduce_motion;
    bool is_simulator;
    bool tiles;              /* home layout: tile grid instead of list */
} cl_device_info_t;

/** Build the UI on the default display. Call once after lv_init() and display setup. */
void cl_ui_init(const cl_platform_t *platform);

/** Show the dashboard (home / agents / usage) — the normal operating screen. */
void cl_ui_show_dashboard(void);

/** Feed a freshly parsed snapshot. Only changed widgets are updated. */
void cl_ui_set_snapshot(const cl_snapshot_t *snap);

/** Connection freshness. last_ok_age_s = seconds since the last good snapshot. */
void cl_ui_set_link(cl_link_t link, uint32_t last_ok_age_s);

void cl_ui_set_device_info(const cl_device_info_t *info);

/* ---- onboarding screens ------------------------------------------------ */

/** First boot: join the device's setup access point (QR code + password). */
void cl_ui_show_wifi_setup(const char *ap_name, const char *ap_password, const char *portal_url);

/** Generic "doing something" screen, e.g. ("Joining Wi-Fi", "HomeNet"). */
void cl_ui_show_progress(const char *title, const char *detail);

/** Discovered companion services. count == 0 shows a searching state with `hint`. */
void cl_ui_show_host_picker(const char *const *hosts, uint8_t count, const char *hint);

/** Pairing challenge: the user types `code` into the Mac's Claudette page. */
void cl_ui_show_pairing(const char *host_name, const char *code);

/** A friendly full-screen message with an optional action button handled by `on_action`. */
void cl_ui_show_message(const char *title, const char *body, const char *action_label,
                        void (*on_action)(void *user), void *user);

#ifdef __cplusplus
}
#endif

#endif /* CL_UI_H */
