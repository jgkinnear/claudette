/**
 * Claudette firmware entry point.
 *
 * Two tasks:
 *   - Arduino loop task (core 1): LVGL + the shared UI. Every cl_ui_* and lv_*
 *     call happens here, and nothing here waits on the network.
 *   - "net" task (core 0, net_task.cpp): Wi-Fi, setup portal, discovery,
 *     pairing and polling. It talks to this loop only through bridge.h.
 */
#include <Arduino.h>
#include <esp_heap_caps.h>
#include <string.h>

#include "board_config.h"
#include "bridge.h"
#include "cl_ui.h"
#include "hal_display.h"
#include "log.h"
#include "net_task.h"
#include "settings.h"

/* LVGL's software renderer (gradients, shadows, arcs) wants more than the default 8 KB. */
SET_LOOP_TASK_STACK_SIZE(16 * 1024);

namespace {

cl_snapshot_t *s_ui_snap;
UiCmd s_cmd;
bool s_dashboard;
bool s_info_dirty = true;
bool s_bright_dirty;
uint32_t s_bright_changed_ms;

void send_simple(NetCmdType type, uint8_t index = 0) {
    NetCmd c;
    memset(&c, 0, sizeof(c));
    c.type = type;
    c.index = index;
    bridge_send_net(c);
}

/* ------------------------------------------------ cl_platform_t callbacks
 * Called by the shared UI on this (LVGL) task. Anything slow goes to the
 * network task as a command. */

void cb_toggle_pin(const char *session_id, bool pinned, void *) {
    if (!session_id) return;
    NetCmd c;
    memset(&c, 0, sizeof(c));
    c.type = NC_TOGGLE_PIN;
    c.flag = pinned;
    strncpy(c.session_id, session_id, sizeof(c.session_id) - 1);
    bridge_send_net(c);
}

void cb_set_brightness(uint8_t percent, void *) {
    if (percent < 5) percent = 5;
    if (percent > 100) percent = 100;
    g_settings.brightness = percent;
    hal_set_brightness(percent);
    s_bright_dirty = true; /* saved once the slider settles */
    s_bright_changed_ms = millis();
    s_info_dirty = true;
}

void cb_set_reduce_motion(bool reduce, void *) {
    g_settings.reduce_motion = reduce;
    settings_save_display();
    s_info_dirty = true;
}

void cb_set_layout(bool tiles, void *) {
    g_settings.tiles = tiles;
    settings_save_display();
    s_info_dirty = true;
}

void cb_select_host(uint8_t index, void *) { send_simple(NC_SELECT_HOST, index); }
void cb_reconnect(void *) { send_simple(NC_RECONNECT); }
void cb_forget_host(void *) { send_simple(NC_FORGET_HOST); }
void cb_factory_reset(void *) { send_simple(NC_FACTORY_RESET); }

void on_message_action(void *user) { send_simple(NC_ACTION, (uint8_t)(uintptr_t)user); }

const cl_platform_t kPlatform = {
    cb_toggle_pin,  cb_set_brightness, cb_set_reduce_motion, cb_select_host, cb_reconnect,
    cb_forget_host, cb_factory_reset,  cb_set_layout,        nullptr,
};

/* ------------------------------------------------------- net -> UI */

void update_link(void);

void apply_ui_cmd(const UiCmd &c) {
    switch (c.type) {
        case UC_WIFI_SETUP:
            s_dashboard = false;
            cl_ui_show_wifi_setup(c.a, c.b, c.c);
            break;
        case UC_PROGRESS:
            s_dashboard = false;
            cl_ui_show_progress(c.a, c.b);
            break;
        case UC_HOST_PICKER: {
            s_dashboard = false;
            const char *list[BRIDGE_MAX_HOSTS];
            uint8_t n = c.count > BRIDGE_MAX_HOSTS ? BRIDGE_MAX_HOSTS : c.count;
            for (uint8_t i = 0; i < n; i++) list[i] = c.hosts[i];
            cl_ui_show_host_picker(list, n, c.b);
            break;
        }
        case UC_PAIRING:
            s_dashboard = false;
            cl_ui_show_pairing(c.a, c.b);
            break;
        case UC_MESSAGE:
            s_dashboard = false;
            if (c.c[0] && c.action != ACT_NONE) {
                cl_ui_show_message(c.a, c.b, c.c, on_message_action, (void *)(uintptr_t)c.action);
            } else {
                cl_ui_show_message(c.a, c.b, nullptr, nullptr, nullptr);
            }
            break;
        case UC_DASHBOARD:
            s_dashboard = true;
            cl_ui_show_dashboard();
            update_link();
            break;
    }
}

void update_link(void) {
    if (!s_dashboard) return;
    NetStatus st;
    bridge_get_status(&st);
    if (!st.polling) return;
    const uint32_t ref = st.last_ok_ms ? st.last_ok_ms : st.polling_since_ms;
    const uint32_t age_ms = millis() - ref;
    cl_link_t link;
    if (age_ms >= CLAUDETTE_OFFLINE_AFTER_MS) {
        link = CL_LINK_OFFLINE;
    } else if (st.last_ok_ms && st.fails == 0) {
        link = CL_LINK_LIVE;
    } else {
        link = CL_LINK_STALE;
    }
    cl_ui_set_link(link, age_ms / 1000);
}

void update_device_info(void) {
    static NetStatus last;
    static uint32_t last_push;
    NetStatus st;
    bridge_get_status(&st);
    int rssi_delta = (int)st.rssi - (int)last.rssi;
    bool changed = s_info_dirty || strcmp(st.ssid, last.ssid) != 0 || strcmp(st.ip, last.ip) != 0 ||
                   strcmp(st.host_label, last.host_label) != 0 || rssi_delta > 4 || rssi_delta < -4 ||
                   millis() - last_push > 30000;
    if (!changed) return;
    last = st;
    last_push = millis();
    s_info_dirty = false;

    cl_device_info_t info;
    memset(&info, 0, sizeof(info));
    info.firmware_version = CLAUDETTE_FW_VERSION;
    info.wifi_ssid = st.ssid;
    info.ip = st.ip;
    info.rssi = st.rssi;
    info.host_label = st.host_label;
    info.brightness = g_settings.brightness;
    info.reduce_motion = g_settings.reduce_motion;
    info.is_simulator = false;
    info.tiles = g_settings.tiles;
    cl_ui_set_device_info(&info);
}

/* ------------------------------------------------- BOOT button + serial */

void service_boot_button(void) {
#if BOOT_BUTTON_PIN >= 0
    static uint32_t down_since;
    static uint32_t last_low;
    static bool hinted;
    static bool fired;
    const uint32_t now = millis();
    if (digitalRead(BOOT_BUTTON_PIN) == LOW) last_low = now;
    const bool pressed = last_low && now - last_low < 60; /* debounce release */

    if (pressed) {
        if (!down_since) down_since = now;
        const uint32_t held = now - down_since;
        if (held >= 10000 && !fired) {
            fired = true;
            LOGI("btn", "BOOT held 10 s: factory reset");
            send_simple(NC_FACTORY_RESET);
        } else if (held >= 3000 && !hinted) {
            hinted = true;
            LOGI("btn", "BOOT held 3 s");
            s_dashboard = false;
            cl_ui_show_progress("Let go for setup", "Keep holding 7 more seconds to factory reset.");
        }
    } else if (down_since) {
        const uint32_t held = now - down_since;
        if (!fired && held >= 3000) {
            LOGI("btn", "opening setup portal");
            send_simple(NC_OPEN_PORTAL);
        }
        down_since = 0;
        hinted = false;
        fired = false;
    }
#endif
}

void print_status(void) {
    NetStatus st;
    bridge_get_status(&st);
    LOGI("stat", "fw %s state=%s wifi=%s ip=%s rssi=%d", CLAUDETTE_FW_VERSION, net_state_name(),
         st.wifi_up ? st.ssid : "-", st.ip[0] ? st.ip : "-", st.rssi);
    LOGI("stat", "host=%s polling=%d fails=%u last_ok=%lus ago", st.host_label[0] ? st.host_label : "-",
         st.polling, st.fails, st.last_ok_ms ? (unsigned long)((millis() - st.last_ok_ms) / 1000) : 0ul);
    LOGI("stat", "heap internal %u free (min %u), psram %u free, uptime %lus",
         (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
         (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
         (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM), (unsigned long)(millis() / 1000));
}

void handle_serial_line(const char *line) {
    if (strcmp(line, "status") == 0) {
        print_status();
    } else if (strcmp(line, "setup") == 0) {
        send_simple(NC_OPEN_PORTAL);
    } else if (strcmp(line, "reconnect") == 0) {
        send_simple(NC_RECONNECT);
    } else if (strcmp(line, "forget") == 0) {
        send_simple(NC_FORGET_HOST);
    } else if (strcmp(line, "factory-reset") == 0) {
        send_simple(NC_FACTORY_RESET);
    } else if (strcmp(line, "reboot") == 0) {
        send_simple(NC_REBOOT);
    } else if (strcmp(line, "touch") == 0) {
        hal_set_touch_log(!hal_touch_log_enabled());
        LOGI("touch", "logging %s", hal_touch_log_enabled() ? "on" : "off");
    } else {
        LOGI("help", "commands: status, setup, reconnect, forget, factory-reset, reboot, touch");
    }
}

void service_serial(void) {
    static char line[32];
    static size_t n;
    int budget = 64;
    while (budget-- > 0 && Serial.available() > 0) {
        int ch = Serial.read();
        if (ch < 0) break;
        if (ch == '\r' || ch == '\n') {
            if (n) {
                line[n] = '\0';
                handle_serial_line(line);
                n = 0;
            }
        } else if (n < sizeof(line) - 1) {
            line[n++] = (char)ch;
        }
    }
}

}  // namespace

void setup() {
    log_init();
    delay(100);
    LOGI("sys", "Claudette %s (%s)", CLAUDETTE_FW_VERSION, CLAUDETTE_BOARD_NAME);
    LOGI("sys", "%s rev %d @ %lu MHz, flash %lu MB, PSRAM %lu KB", ESP.getChipModel(), (int)ESP.getChipRevision(),
         (unsigned long)getCpuFrequencyMhz(), (unsigned long)(ESP.getFlashChipSize() / (1024 * 1024)),
         (unsigned long)(ESP.getPsramSize() / 1024));
    if (!psramFound()) {
        LOGI("sys", "WARNING: no PSRAM detected; check board_build.arduino.memory_type");
    }

    settings_load();
    bridge_init();
#if BOOT_BUTTON_PIN >= 0
    pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);
#endif

    if (!hal_display_init(g_settings.brightness)) {
        LOGI("sys", "display init failed; continuing headless");
    }

    s_ui_snap = (cl_snapshot_t *)heap_caps_calloc(1, sizeof(cl_snapshot_t), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_ui_snap) s_ui_snap = (cl_snapshot_t *)calloc(1, sizeof(cl_snapshot_t));

    cl_ui_init(&kPlatform);
    update_device_info();
    cl_ui_show_progress("Hello!", "Waking up\xE2\x80\xA6");
    lv_timer_handler();

    net_task_start();
    LOGI("sys", "ready; type 'help' for serial commands");
}

void loop() {
    /* Screens first, then data, so a dashboard switch precedes its first snapshot. */
    for (int i = 0; i < 4 && bridge_recv_ui(&s_cmd); i++) apply_ui_cmd(s_cmd);
    if (s_ui_snap && bridge_take_snapshot(s_ui_snap)) cl_ui_set_snapshot(s_ui_snap);

    static uint32_t last_tick;
    const uint32_t now = millis();
    if (now - last_tick >= 1000) {
        last_tick = now;
        update_link();
        update_device_info();
    }
    static uint32_t last_heap_log;
    if (now - last_heap_log >= 300000) {
        last_heap_log = now;
        LOGI("sys", "heap internal %u (min %u), psram %u", (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    }
    if (s_bright_dirty && now - s_bright_changed_ms > 1500) {
        s_bright_dirty = false;
        settings_save_display();
    }

    service_boot_button();
    service_serial();

    uint32_t wait = lv_timer_handler();
    if (wait > 10) wait = 10;
    if (wait < 1) wait = 1;
    delay(wait);
}
