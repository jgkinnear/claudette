/**
 * Hand-off between the network task (core 0) and the UI/LVGL task (core 1).
 *
 *   UI -> net : NetCmd queue (button presses, callbacks from cl_platform_t)
 *   net -> UI : UiCmd queue (which onboarding screen to show)
 *               latest snapshot (copied under a mutex, newest wins)
 *               NetStatus (link freshness + device info, under the same mutex)
 *
 * Only the UI task calls cl_ui_* / lv_*. The network task never touches LVGL.
 */
#pragma once

#include <stdint.h>

#include "cl_model.h"

#define BRIDGE_MAX_HOSTS 6
#define BRIDGE_HOST_LABEL 72

enum NetCmdType : uint8_t {
    NC_NONE = 0,
    NC_SELECT_HOST,
    NC_TOGGLE_PIN,
    NC_RECONNECT,
    NC_FORGET_HOST,
    NC_FACTORY_RESET,
    NC_OPEN_PORTAL,
    NC_ACTION,  /* button on a cl_ui_show_message() screen; index = MsgAction */
    NC_REBOOT,
};

enum MsgAction : uint8_t {
    ACT_NONE = 0,
    ACT_RETRY,        /* retry whatever just failed */
    ACT_OPEN_PORTAL,  /* re-run the Wi-Fi / manual host setup portal */
    ACT_DISCOVER,     /* forget the current host choice and search again */
};

struct NetCmd {
    NetCmdType type;
    uint8_t index;
    bool flag;
    char session_id[CL_MAX_ID];
};

enum UiCmdType : uint8_t {
    UC_WIFI_SETUP,
    UC_PROGRESS,
    UC_HOST_PICKER,
    UC_PAIRING,
    UC_MESSAGE,
    UC_DASHBOARD,
};

struct UiCmd {
    UiCmdType type;
    uint8_t count;   /* host picker entries */
    uint8_t action;  /* MsgAction for UC_MESSAGE */
    char a[72];      /* title / ap name / host name */
    char b[200];     /* detail / password / code / hint / body */
    char c[40];      /* portal url / action label */
    char hosts[BRIDGE_MAX_HOSTS][BRIDGE_HOST_LABEL];
};

struct NetStatus {
    bool polling;              /* in the running state (dashboard) */
    uint32_t polling_since_ms;
    uint32_t last_ok_ms;       /* 0 = no good snapshot yet in this run */
    uint16_t fails;            /* consecutive failed polls */
    bool wifi_up;
    char ssid[33];
    char ip[16];
    int8_t rssi;
    char host_label[96];
};

void bridge_init(void);

/* ---- UI side ---- */
bool bridge_send_net(const NetCmd &cmd);
bool bridge_recv_ui(UiCmd *out);                 /* non-blocking */
bool bridge_take_snapshot(cl_snapshot_t *dst);   /* true if a newer one was copied */
void bridge_get_status(NetStatus *out);

/* ---- network side ---- */
bool bridge_recv_net(NetCmd *out, uint32_t wait_ms);
void bridge_send_ui(const UiCmd &cmd);
cl_snapshot_t *bridge_scratch(void);             /* net-owned parse target */
void bridge_publish_scratch(void);               /* copy scratch -> pending */

void bridge_set_polling(bool on);
void bridge_poll_ok(void);
void bridge_poll_fail(void);
void bridge_set_wifi(bool up, const char *ssid, const char *ip, int8_t rssi);
void bridge_set_host_label(const char *label);

/* ---- convenience senders for the network task ---- */
void ui_progress(const char *title, const char *detail);
void ui_wifi_setup(const char *ap, const char *password, const char *url);
void ui_host_picker(const char hosts[][BRIDGE_HOST_LABEL], uint8_t count, const char *hint);
void ui_pairing(const char *host_name, const char *code);
void ui_message(const char *title, const char *body, const char *action_label, MsgAction action);
void ui_dashboard(void);
