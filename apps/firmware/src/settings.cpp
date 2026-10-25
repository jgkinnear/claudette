#include "settings.h"

#include <Arduino.h>
#include <Preferences.h>
#include <esp_random.h>
#include <string.h>

#include "board_config.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "log.h"

#if __has_include("secrets.h")
#include "secrets.h"
#endif

Settings g_settings;

static const char *NS = "claudette";
static SemaphoreHandle_t s_mutex;

namespace {

struct Lock {
    Lock() { xSemaphoreTake(s_mutex, portMAX_DELAY); }
    ~Lock() { xSemaphoreGive(s_mutex); }
};

void get_str(Preferences &p, const char *key, char *dst, size_t size) {
    dst[0] = '\0';
    if (!p.isKey(key)) return;
    size_t n = p.getString(key, dst, size);
    if (n == 0) dst[0] = '\0';
    dst[size - 1] = '\0';
}

void copy(char *dst, size_t size, const char *src) {
    strncpy(dst, src ? src : "", size - 1);
    dst[size - 1] = '\0';
}

}  // namespace

void settings_load(void) {
    if (!s_mutex) s_mutex = xSemaphoreCreateMutex();
    Lock lock;
    memset(&g_settings, 0, sizeof(g_settings));
    g_settings.brightness = 80;
    g_settings.host.port = CLAUDETTE_DEFAULT_PORT;

    Preferences p;
    /* read-write so the namespace is created on first boot */
    if (!p.begin(NS, false)) {
        LOGI("cfg", "NVS open failed, using defaults");
        return;
    }
    get_str(p, "ssid", g_settings.ssid, sizeof(g_settings.ssid));
    get_str(p, "pass", g_settings.pass, sizeof(g_settings.pass));
    get_str(p, "h_name", g_settings.host.name, sizeof(g_settings.host.name));
    get_str(p, "h_addr", g_settings.host.addr, sizeof(g_settings.host.addr));
    get_str(p, "h_mdns", g_settings.host.mdns, sizeof(g_settings.host.mdns));
    get_str(p, "h_id", g_settings.host.id, sizeof(g_settings.host.id));
    g_settings.host.port = p.getUShort("h_port", CLAUDETTE_DEFAULT_PORT);
    g_settings.host.manual = p.getBool("h_manual", false);
    get_str(p, "dev_id", g_settings.device_id, sizeof(g_settings.device_id));
    get_str(p, "token", g_settings.token, sizeof(g_settings.token));
    g_settings.brightness = p.getUChar("bright", 80);
    g_settings.reduce_motion = p.getBool("rmotion", false);
    g_settings.tiles = p.getBool("tiles", false);
    g_settings.rotation = p.getUChar("rot", 0) & 3;
    p.end();

    if (g_settings.brightness < 5) g_settings.brightness = 5;
    if (g_settings.brightness > 100) g_settings.brightness = 100;
    if (g_settings.host.port == 0) g_settings.host.port = CLAUDETTE_DEFAULT_PORT;

#if defined(DEV_WIFI_SSID)
    /* Developer convenience (include/secrets.h, gitignored): only used when
     * nothing has been saved through the setup portal. */
    if (!g_settings.ssid[0]) {
        copy(g_settings.ssid, sizeof(g_settings.ssid), DEV_WIFI_SSID);
#if defined(DEV_WIFI_PASSWORD)
        copy(g_settings.pass, sizeof(g_settings.pass), DEV_WIFI_PASSWORD);
#endif
        LOGI("cfg", "using dev Wi-Fi from secrets.h");
    }
#endif
#if defined(DEV_HOST_ADDR)
    if (!g_settings.host.addr[0]) {
        copy(g_settings.host.addr, sizeof(g_settings.host.addr), DEV_HOST_ADDR);
        copy(g_settings.host.name, sizeof(g_settings.host.name), DEV_HOST_ADDR);
#if defined(DEV_HOST_PORT)
        g_settings.host.port = DEV_HOST_PORT;
#endif
        g_settings.host.manual = true;
    }
#endif

    LOGI("cfg", "wifi=%s host=%s token=%s bright=%u",
         g_settings.ssid[0] ? "saved" : "none",
         g_settings.host.addr[0] ? (g_settings.host.manual ? "manual" : "saved") : "none",
         g_settings.token[0] ? "yes" : "no", g_settings.brightness);
}

void settings_save_wifi(void) {
    Lock lock;
    Preferences p;
    if (!p.begin(NS, false)) return;
    p.putString("ssid", g_settings.ssid);
    p.putString("pass", g_settings.pass);
    p.end();
}

void settings_save_host(void) {
    Lock lock;
    Preferences p;
    if (!p.begin(NS, false)) return;
    p.putString("h_name", g_settings.host.name);
    p.putString("h_addr", g_settings.host.addr);
    p.putString("h_mdns", g_settings.host.mdns);
    p.putString("h_id", g_settings.host.id);
    p.putUShort("h_port", g_settings.host.port);
    p.putBool("h_manual", g_settings.host.manual);
    p.end();
}

void settings_save_token(void) {
    Lock lock;
    Preferences p;
    if (!p.begin(NS, false)) return;
    if (g_settings.token[0]) {
        p.putString("token", g_settings.token);
    } else if (p.isKey("token")) {
        p.remove("token");
    }
    p.end();
}

void settings_save_device_id(void) {
    Lock lock;
    Preferences p;
    if (!p.begin(NS, false)) return;
    p.putString("dev_id", g_settings.device_id);
    p.end();
}

void settings_save_display(void) {
    Lock lock;
    Preferences p;
    if (!p.begin(NS, false)) return;
    p.putUChar("bright", g_settings.brightness);
    p.putBool("rmotion", g_settings.reduce_motion);
    p.putBool("tiles", g_settings.tiles);
    p.putUChar("rot", g_settings.rotation);
    p.end();
}

void settings_clear_pairing(bool forget_host) {
    memset(g_settings.token, 0, sizeof(g_settings.token));
    settings_save_token();
    if (forget_host) {
        memset(&g_settings.host, 0, sizeof(g_settings.host));
        g_settings.host.port = CLAUDETTE_DEFAULT_PORT;
        settings_save_host();
    }
}

void settings_factory_reset(void) {
    Lock lock;
    Preferences p;
    if (p.begin(NS, false)) {
        p.clear();
        p.end();
    }
    memset(g_settings.ssid, 0, sizeof(g_settings.ssid));
    memset(g_settings.pass, 0, sizeof(g_settings.pass));
    memset(g_settings.token, 0, sizeof(g_settings.token));
    memset(&g_settings.host, 0, sizeof(g_settings.host));
    g_settings.host.port = CLAUDETTE_DEFAULT_PORT;
}

bool settings_has_wifi(void) { return g_settings.ssid[0] != '\0'; }
bool settings_has_host(void) { return g_settings.host.addr[0] != '\0'; }
bool settings_has_token(void) { return g_settings.token[0] != '\0'; }

void settings_ensure_device_id(void) {
    if (g_settings.device_id[0]) return;
    /* Call after Wi-Fi is up: esp_random() is then backed by RF noise. */
    uint8_t b[8];
    esp_fill_random(b, sizeof(b));
    snprintf(g_settings.device_id, sizeof(g_settings.device_id),
             "cl-%02x%02x%02x%02x%02x%02x%02x%02x", b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]);
    settings_save_device_id();
    LOGI("cfg", "generated device id");
}
