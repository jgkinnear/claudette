#include "bridge.h"

#include <Arduino.h>
#include <esp_heap_caps.h>
#include <string.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/semphr.h"
#include "log.h"

static QueueHandle_t s_net_q;
static QueueHandle_t s_ui_q;
static SemaphoreHandle_t s_mutex;

static cl_snapshot_t *s_scratch;
static cl_snapshot_t *s_pending;
static bool s_pending_fresh;
static NetStatus s_status;

static void *alloc_prefer_psram(size_t size) {
    void *p = heap_caps_calloc(1, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!p) p = calloc(1, size);
    return p;
}

static void copy_str(char *dst, size_t size, const char *src) {
    if (!src) src = "";
    strncpy(dst, src, size - 1);
    dst[size - 1] = '\0';
}

void bridge_init(void) {
    s_net_q = xQueueCreate(8, sizeof(NetCmd));
    s_ui_q = xQueueCreate(6, sizeof(UiCmd));
    s_mutex = xSemaphoreCreateMutex();
    s_scratch = (cl_snapshot_t *)alloc_prefer_psram(sizeof(cl_snapshot_t));
    s_pending = (cl_snapshot_t *)alloc_prefer_psram(sizeof(cl_snapshot_t));
    memset(&s_status, 0, sizeof(s_status));
    if (!s_net_q || !s_ui_q || !s_mutex || !s_scratch || !s_pending) {
        LOGI("sys", "bridge alloc failed");
    }
}

/* ---------------------------------------------------------------- UI side */

bool bridge_send_net(const NetCmd &cmd) {
    if (xQueueSend(s_net_q, &cmd, 0) != pdTRUE) {
        LOGI("ui", "net queue full, dropped cmd %u", cmd.type);
        return false;
    }
    return true;
}

bool bridge_recv_ui(UiCmd *out) { return xQueueReceive(s_ui_q, out, 0) == pdTRUE; }

bool bridge_take_snapshot(cl_snapshot_t *dst) {
    bool fresh = false;
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (s_pending_fresh) {
        memcpy(dst, s_pending, sizeof(cl_snapshot_t));
        s_pending_fresh = false;
        fresh = true;
    }
    xSemaphoreGive(s_mutex);
    return fresh;
}

void bridge_get_status(NetStatus *out) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    *out = s_status;
    xSemaphoreGive(s_mutex);
}

/* ----------------------------------------------------------- network side */

bool bridge_recv_net(NetCmd *out, uint32_t wait_ms) {
    return xQueueReceive(s_net_q, out, pdMS_TO_TICKS(wait_ms)) == pdTRUE;
}

void bridge_send_ui(const UiCmd &cmd) {
    /* The UI drains this every few ms; if it is wedged, drop the oldest screen
     * request rather than block networking. Only the newest screen matters. */
    if (xQueueSend(s_ui_q, &cmd, pdMS_TO_TICKS(200)) != pdTRUE) {
        static UiCmd discard;
        xQueueReceive(s_ui_q, &discard, 0);
        xQueueSend(s_ui_q, &cmd, 0);
    }
}

cl_snapshot_t *bridge_scratch(void) { return s_scratch; }

void bridge_publish_scratch(void) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    memcpy(s_pending, s_scratch, sizeof(cl_snapshot_t));
    s_pending_fresh = true;
    xSemaphoreGive(s_mutex);
}

void bridge_set_polling(bool on) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_status.polling = on;
    s_status.polling_since_ms = millis();
    s_status.last_ok_ms = 0;
    s_status.fails = 0;
    xSemaphoreGive(s_mutex);
}

void bridge_poll_ok(void) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_status.last_ok_ms = millis();
    if (s_status.last_ok_ms == 0) s_status.last_ok_ms = 1;
    s_status.fails = 0;
    xSemaphoreGive(s_mutex);
}

void bridge_poll_fail(void) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    if (s_status.fails < 0xFFFF) s_status.fails++;
    xSemaphoreGive(s_mutex);
}

void bridge_set_wifi(bool up, const char *ssid, const char *ip, int8_t rssi) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    s_status.wifi_up = up;
    copy_str(s_status.ssid, sizeof(s_status.ssid), up ? ssid : "");
    copy_str(s_status.ip, sizeof(s_status.ip), up ? ip : "");
    s_status.rssi = up ? rssi : 0;
    xSemaphoreGive(s_mutex);
}

void bridge_set_host_label(const char *label) {
    xSemaphoreTake(s_mutex, portMAX_DELAY);
    copy_str(s_status.host_label, sizeof(s_status.host_label), label);
    xSemaphoreGive(s_mutex);
}

/* ------------------------------------------------------ screen helpers */

static UiCmd s_cmd; /* only used from the network task */

void ui_progress(const char *title, const char *detail) {
    memset(&s_cmd, 0, sizeof(s_cmd));
    s_cmd.type = UC_PROGRESS;
    copy_str(s_cmd.a, sizeof(s_cmd.a), title);
    copy_str(s_cmd.b, sizeof(s_cmd.b), detail);
    bridge_send_ui(s_cmd);
}

void ui_wifi_setup(const char *ap, const char *password, const char *url) {
    memset(&s_cmd, 0, sizeof(s_cmd));
    s_cmd.type = UC_WIFI_SETUP;
    copy_str(s_cmd.a, sizeof(s_cmd.a), ap);
    copy_str(s_cmd.b, sizeof(s_cmd.b), password);
    copy_str(s_cmd.c, sizeof(s_cmd.c), url);
    bridge_send_ui(s_cmd);
}

void ui_host_picker(const char hosts[][BRIDGE_HOST_LABEL], uint8_t count, const char *hint) {
    memset(&s_cmd, 0, sizeof(s_cmd));
    s_cmd.type = UC_HOST_PICKER;
    if (count > BRIDGE_MAX_HOSTS) count = BRIDGE_MAX_HOSTS;
    s_cmd.count = count;
    for (uint8_t i = 0; i < count; i++) copy_str(s_cmd.hosts[i], BRIDGE_HOST_LABEL, hosts[i]);
    copy_str(s_cmd.b, sizeof(s_cmd.b), hint);
    bridge_send_ui(s_cmd);
}

void ui_pairing(const char *host_name, const char *code) {
    memset(&s_cmd, 0, sizeof(s_cmd));
    s_cmd.type = UC_PAIRING;
    copy_str(s_cmd.a, sizeof(s_cmd.a), host_name);
    copy_str(s_cmd.b, sizeof(s_cmd.b), code);
    bridge_send_ui(s_cmd);
}

void ui_message(const char *title, const char *body, const char *action_label, MsgAction action) {
    memset(&s_cmd, 0, sizeof(s_cmd));
    s_cmd.type = UC_MESSAGE;
    s_cmd.action = action;
    copy_str(s_cmd.a, sizeof(s_cmd.a), title);
    copy_str(s_cmd.b, sizeof(s_cmd.b), body);
    copy_str(s_cmd.c, sizeof(s_cmd.c), action_label);
    bridge_send_ui(s_cmd);
}

void ui_dashboard(void) {
    memset(&s_cmd, 0, sizeof(s_cmd));
    s_cmd.type = UC_DASHBOARD;
    bridge_send_ui(s_cmd);
}
