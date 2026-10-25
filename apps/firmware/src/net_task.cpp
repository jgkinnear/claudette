/**
 * Network state machine (core 0).
 *
 *   WIFI ──joined──▶ CHECK_HOST (host saved) ──token──▶ RUNNING
 *    │  └─────────▶ DISCOVER ──picked──▶ CHECK_HOST ──health ok──▶ PAIR ──approved──▶ RUNNING
 *    └─fails 3x──▶ PORTAL ──saved──▶ reboot                         RUNNING ──401──▶ CHECK_HOST
 *
 * Every state waits through idle(), which serves UI commands (factory reset,
 * forget host, open portal, message buttons) and watches Wi-Fi, so nothing here
 * ever blocks for longer than one HTTP timeout (3 s) or one mDNS browse (3 s).
 */
#include "net_task.h"

#include <ArduinoJson.h>
#include <WiFi.h>
#include <esp_heap_caps.h>
#include <esp_mac.h>
#include <string.h>
#include <strings.h>

#include "board_config.h"
#include "bridge.h"
#include "cl_model.h"
#include "discovery.h"
#include "http_api.h"
#include "log.h"
#include "portal.h"
#include "settings.h"
#include "util.h"

namespace {

enum State : uint8_t { S_WIFI, S_PORTAL, S_DISCOVER, S_CHECK_HOST, S_PAIR, S_RUNNING, S_WAIT_USER };
const char *const kStateNames[] = {"wifi", "portal", "discover", "check-host", "pair", "running", "wait-user"};

volatile State s_state = S_WIFI;
State s_retry_state = S_WIFI;
bool s_state_changed;
uint32_t s_auto_retry_ms;      /* S_WAIT_USER: retry on our own after this long (0 = never) */
char s_portal_reason[80];

char s_dev_name[24];   /* "Claudette-A1B2": AP name + device name shown on the Mac */
char s_mdns_name[24];  /* "claudette-a1b2": our own mDNS / DHCP hostname */

IPAddress s_host_ip;
bool s_host_ip_ok;
char *s_body;          /* CLAUDETTE_MAX_BODY + 1, PSRAM */
const size_t kBodyCap = CLAUDETTE_MAX_BODY + 1;

bool s_wifi_managed;   /* station mode: watch and rejoin */
bool s_wifi_was_up;
bool s_wifi_regained;
uint32_t s_wifi_down_since;
uint32_t s_last_kick;
uint32_t s_last_wifi_pub;

/* ------------------------------------------------------------------ utils */

void set_state(State s) {
    if (s != s_state) LOGI("net", "%s -> %s", kStateNames[s_state], kStateNames[s]);
    s_state = s;
    s_state_changed = true;
}

bool wifi_up(void) { return WiFi.status() == WL_CONNECTED; }

State next_after_wifi(void) { return settings_has_host() ? S_CHECK_HOST : S_DISCOVER; }

void publish_wifi(void) {
    if (wifi_up()) {
        bridge_set_wifi(true, WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), (int8_t)WiFi.RSSI());
    } else {
        bridge_set_wifi(false, "", "", 0);
    }
    s_last_wifi_pub = millis();
}

void publish_host_label(void) {
    if (!settings_has_host()) {
        bridge_set_host_label("");
        return;
    }
    char label[96];
    snprintf(label, sizeof(label), "%s \xC2\xB7 %s:%u", g_settings.host.name[0] ? g_settings.host.name : "Mac",
             g_settings.host.addr, g_settings.host.port);
    bridge_set_host_label(label);
}

void on_wifi_up(void) {
    s_wifi_managed = true;
    s_wifi_was_up = true;
    s_wifi_down_since = 0;
    LOGI("wifi", "connected: ip %s rssi %d ch %d", WiFi.localIP().toString().c_str(), (int)WiFi.RSSI(),
         (int)WiFi.channel());
    publish_wifi();
    discovery_begin(s_mdns_name);
    settings_ensure_device_id();
}

/* Station-mode Wi-Fi supervision (called from idle()). */
void wifi_service(void) {
    if (!s_wifi_managed) return;
    const uint32_t now = millis();
    if (wifi_up()) {
        if (!s_wifi_was_up) {
            LOGI("wifi", "back: ip %s rssi %d", WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
            s_wifi_was_up = true;
            s_wifi_regained = true;
            s_wifi_down_since = 0;
            publish_wifi();
        } else if (now - s_last_wifi_pub > 5000) {
            publish_wifi();
        }
        return;
    }
    if (s_wifi_was_up) {
        LOGI("wifi", "lost connection");
        s_wifi_was_up = false;
        s_wifi_down_since = now;
        s_last_kick = now;
        publish_wifi();
    }
    /* Auto-reconnect usually handles it; kick it if it has been down a while. */
    if (now - s_last_kick > 30000) {
        s_last_kick = now;
        LOGI("wifi", "rejoining \"%s\"", g_settings.ssid);
        WiFi.disconnect();
        WiFi.begin(g_settings.ssid, g_settings.pass);
    }
}

[[noreturn]] void do_factory_reset(void) {
    LOGI("sys", "factory reset");
    ui_progress("Factory reset", "Forgetting Wi-Fi and pairing\xE2\x80\xA6");
    settings_factory_reset();
    WiFi.disconnect(true, true);
    delay(1200);
    ESP.restart();
    for (;;) delay(1000);
}

State restart_state(void) {
    if (!settings_has_wifi()) return S_PORTAL;
    if (!wifi_up()) return S_WIFI;
    return next_after_wifi();
}

void handle_global(const NetCmd &c) {
    switch (c.type) {
        case NC_FACTORY_RESET:
            do_factory_reset();
            break;
        case NC_REBOOT:
            LOGI("sys", "reboot requested");
            delay(200);
            ESP.restart();
            break;
        case NC_FORGET_HOST:
            LOGI("net", "forgetting host");
            settings_clear_pairing(true);
            s_host_ip_ok = false;
            publish_host_label();
            set_state(wifi_up() ? S_DISCOVER : restart_state());
            break;
        case NC_OPEN_PORTAL:
            if (s_state != S_PORTAL) set_state(S_PORTAL);
            break;
        case NC_RECONNECT:
            if (s_state != S_PORTAL) set_state(restart_state());
            break;
        case NC_ACTION:
            switch ((MsgAction)c.index) {
                case ACT_RETRY: set_state(s_retry_state); break;
                case ACT_OPEN_PORTAL: set_state(S_PORTAL); break;
                case ACT_DISCOVER:
                    settings_clear_pairing(true);
                    s_host_ip_ok = false;
                    publish_host_label();
                    set_state(wifi_up() ? S_DISCOVER : restart_state());
                    break;
                default: break;
            }
            break;
        default:
            break; /* select-host / toggle-pin outside their state: ignore */
    }
}

/**
 * Wait up to `ms`, serving commands and Wi-Fi supervision.
 * Returns false if a command moved us to another state (caller must return).
 * With `local`, NC_SELECT_HOST / NC_TOGGLE_PIN / NC_RECONNECT are handed back
 * to the caller instead (returns true early, local->type set).
 */
bool idle(uint32_t ms, NetCmd *local = nullptr) {
    if (local) local->type = NC_NONE;
    s_state_changed = false;
    const uint32_t start = millis();
    do {
        const uint32_t elapsed = millis() - start;
        uint32_t wait = ms > elapsed ? ms - elapsed : 0;
        if (wait > 250) wait = 250;
        NetCmd c;
        if (bridge_recv_net(&c, wait)) {
            if (local && (c.type == NC_SELECT_HOST || c.type == NC_TOGGLE_PIN || c.type == NC_RECONNECT)) {
                *local = c;
                return true;
            }
            handle_global(c);
            if (s_state_changed) return false;
        }
        wifi_service();
    } while (millis() - start < ms);
    return true;
}

void fail_with(const char *title, const char *body, const char *action_label, MsgAction action, State retry,
               uint32_t auto_retry_ms = 0) {
    s_retry_state = retry;
    s_auto_retry_ms = auto_retry_ms;
    ui_message(title, body, action_label, action);
    set_state(S_WAIT_USER);
}

bool resolve_host(void) {
    IPAddress ip;
    if (discovery_resolve(g_settings.host.addr, &ip)) {
        if (!s_host_ip_ok || ip != s_host_ip) {
            LOGI("net", "host %s -> %s", g_settings.host.addr, ip.toString().c_str());
        }
        s_host_ip = ip;
        s_host_ip_ok = true;
        return true;
    }
    LOGI("net", "can't resolve %s", g_settings.host.addr);
    return false;
}

bool is_ipv4(const char *s) {
    IPAddress ip;
    return ip.fromString(s);
}

/* Find our paired host again after an IP change. Only adopts an entry whose
 * host id or mDNS hostname matches the one we paired with. */
void rediscover(void) {
    if (g_settings.host.manual) {
        if (!is_ipv4(g_settings.host.addr)) resolve_host();
        return;
    }
    DiscoveredHost found[8];
    int n = discovery_query(found, 8);
    for (int i = 0; i < n; i++) {
        const DiscoveredHost &h = found[i];
        bool match = (g_settings.host.id[0] && h.id[0] && strcmp(h.id, g_settings.host.id) == 0) ||
                     (g_settings.host.mdns[0] && strcasecmp(h.mdns, g_settings.host.mdns) == 0);
        if (!match) continue;
        if (strcmp(h.addr, g_settings.host.addr) != 0 || h.port != g_settings.host.port) {
            LOGI("mdns", "host moved to %s:%u", h.addr, h.port);
            util_copy_utf8(g_settings.host.addr, sizeof(g_settings.host.addr), h.addr);
            g_settings.host.port = h.port;
            settings_save_host();
            publish_host_label();
        }
        resolve_host();
        return;
    }
    if (g_settings.host.mdns[0]) {
        IPAddress ip;
        if (discovery_resolve(g_settings.host.mdns, &ip)) {
            char addr[16];
            snprintf(addr, sizeof(addr), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
            if (strcmp(addr, g_settings.host.addr) != 0) {
                LOGI("mdns", "host hostname now at %s", addr);
                util_copy_utf8(g_settings.host.addr, sizeof(g_settings.host.addr), addr);
                settings_save_host();
                publish_host_label();
            }
            s_host_ip = ip;
            s_host_ip_ok = true;
        }
    }
}

bool safe_id(const char *s, size_t max_len) {
    size_t n = strlen(s);
    if (n == 0 || n > max_len) return false;
    for (size_t i = 0; i < n; i++) {
        char c = s[i];
        if (!(isalnum((unsigned char)c) || c == '-' || c == '_' || c == '.' || c == '~')) return false;
    }
    return true;
}

/* -------------------------------------------------------------- states */

void run_wifi(void) {
    s_wifi_managed = false;
    if (!settings_has_wifi()) {
        set_state(S_PORTAL);
        return;
    }
    WiFi.persistent(false);
    WiFi.setHostname(s_mdns_name);
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false); /* snappier mDNS + HTTP; we're on USB power */
    WiFi.setAutoReconnect(true);

    for (int attempt = 1; attempt <= 3; attempt++) {
        ui_progress("Joining Wi-Fi", g_settings.ssid);
        LOGI("wifi", "joining \"%s\" (try %d/3)", g_settings.ssid, attempt);
        WiFi.disconnect();
        WiFi.begin(g_settings.ssid, g_settings.pass);
        const uint32_t t0 = millis();
        while (millis() - t0 < 15000) {
            if (wifi_up()) {
                on_wifi_up();
                set_state(next_after_wifi());
                return;
            }
            if (!idle(250)) return;
        }
        LOGI("wifi", "join failed (status %d)", (int)WiFi.status());
    }
    snprintf(s_portal_reason, sizeof(s_portal_reason), "I couldn't join \"%s\".", g_settings.ssid);
    set_state(S_PORTAL);
}

void run_portal(void) {
    s_wifi_managed = false;
    WiFi.setAutoReconnect(false);
    WiFi.disconnect();
    WiFi.mode(WIFI_AP_STA); /* radio on: esp_random() is now true RNG */

    if (s_portal_reason[0]) {
        char body[200];
        snprintf(body, sizeof(body), "%s Check the password, or pick another network. Opening setup\xE2\x80\xA6",
                 s_portal_reason);
        ui_message("Wi-Fi trouble", body, nullptr, ACT_NONE);
        s_portal_reason[0] = '\0';
        if (!idle(4000)) return;
    }

    char ap_pass[20];
    util_friendly_password(ap_pass, sizeof(ap_pass));
    if (!portal_start(s_dev_name, ap_pass)) {
        ui_message("Setup hiccup", "I couldn't start my setup hotspot. Restarting\xE2\x80\xA6", nullptr, ACT_NONE);
        delay(3000);
        ESP.restart();
    }
    ui_wifi_setup(s_dev_name, ap_pass, "http://192.168.4.1");

    uint32_t last_try = millis();
    uint32_t try_start = 0;
    bool trying = false;
    for (;;) {
        portal_loop();
        if (portal_saved()) {
            ui_progress("Saved!", "Restarting to join your Wi-Fi\xE2\x80\xA6");
            const uint32_t t = millis();
            while (millis() - t < 1500) {
                portal_loop();
                delay(5);
            }
            util_wipe(ap_pass, sizeof(ap_pass));
            ESP.restart();
        }
        /* With saved credentials (e.g. the router was just slow to boot), quietly
         * retry them when nobody is using the setup hotspot. */
        if (settings_has_wifi()) {
            if (!trying && portal_clients() == 0 && millis() - last_try > 120000) {
                trying = true;
                try_start = millis();
                LOGI("setup", "retrying saved Wi-Fi in the background");
                WiFi.begin(g_settings.ssid, g_settings.pass);
            }
            if (trying) {
                if (wifi_up()) {
                    portal_stop();
                    util_wipe(ap_pass, sizeof(ap_pass));
                    WiFi.setAutoReconnect(true);
                    on_wifi_up();
                    set_state(next_after_wifi());
                    return;
                }
                if (millis() - try_start > 12000 || portal_clients() > 0) {
                    WiFi.disconnect();
                    trying = false;
                    last_try = millis();
                }
            }
        }
        if (!idle(5)) {
            portal_stop();
            util_wipe(ap_pass, sizeof(ap_pass));
            WiFi.setAutoReconnect(true);
            return;
        }
    }
}

void run_discover(void) {
    if (g_settings.host.manual && settings_has_host()) {
        set_state(S_CHECK_HOST);
        return;
    }
    static const char *kSearching = "Looking for Claudette on your network\xE2\x80\xA6";
    static DiscoveredHost found[BRIDGE_MAX_HOSTS];
    static char labels[BRIDGE_MAX_HOSTS][BRIDGE_HOST_LABEL];
    int nfound = 0;
    int shown = -1;
    bool long_hint = false;
    uint32_t t0 = millis();

    LOGI("mdns", "browsing _claudette._tcp");
    for (;;) {
        if (wifi_up()) {
            DiscoveredHost batch[8];
            int n = discovery_query(batch, 8);
            for (int i = 0; i < n; i++) {
                int match = -1;
                for (int k = 0; k < nfound; k++) {
                    if ((batch[i].id[0] && strcmp(batch[i].id, found[k].id) == 0) ||
                        (batch[i].mdns[0] && strcasecmp(batch[i].mdns, found[k].mdns) == 0 &&
                         batch[i].port == found[k].port) ||
                        (strcmp(batch[i].addr, found[k].addr) == 0 && batch[i].port == found[k].port)) {
                        match = k;
                        break;
                    }
                }
                if (match >= 0) {
                    found[match] = batch[i]; /* refresh address; index (= what the UI shows) is stable */
                } else if (nfound < BRIDGE_MAX_HOSTS) {
                    found[nfound++] = batch[i];
                }
            }
        }
        if (nfound != shown) {
            for (int i = 0; i < nfound; i++) {
                bool dup = false;
                for (int k = 0; k < nfound; k++) {
                    if (k != i && strcmp(found[k].name, found[i].name) == 0) dup = true;
                }
                if (dup) {
                    snprintf(labels[i], BRIDGE_HOST_LABEL, "%s (%s)", found[i].name, found[i].addr);
                } else {
                    util_copy_utf8(labels[i], BRIDGE_HOST_LABEL, found[i].name);
                }
            }
            ui_host_picker(labels, (uint8_t)nfound, nfound ? "Tap your Mac to pair with it." : kSearching);
            if (nfound) LOGI("mdns", "found %d host(s)", nfound);
            shown = nfound;
        } else if (nfound == 0 && !long_hint && millis() - t0 > 30000) {
            long_hint = true;
            LOGI("mdns", "nothing found after 30 s");
            ui_message("Can't find your Mac",
                       "Is the Claudette app running on your Mac, on this Wi-Fi? Some networks block "
                       "discovery: you can type your Mac's address instead. I'll keep looking.",
                       "Enter address", ACT_OPEN_PORTAL);
        }

        NetCmd local;
        if (!idle(nfound ? 4000 : 1500, &local)) return;
        if (local.type == NC_SELECT_HOST) {
            if (local.index >= nfound) continue;
            const DiscoveredHost &h = found[local.index];
            settings_clear_pairing(false); /* a new host always means a new pairing */
            memset(&g_settings.host, 0, sizeof(g_settings.host));
            util_copy_utf8(g_settings.host.name, sizeof(g_settings.host.name), h.name);
            util_copy_utf8(g_settings.host.addr, sizeof(g_settings.host.addr), h.addr);
            util_copy_utf8(g_settings.host.mdns, sizeof(g_settings.host.mdns), h.mdns);
            util_copy_utf8(g_settings.host.id, sizeof(g_settings.host.id), h.id);
            g_settings.host.port = h.port;
            g_settings.host.manual = false;
            s_host_ip_ok = false;
            LOGI("mdns", "picked %s:%u", h.addr, h.port);
            set_state(S_CHECK_HOST);
            return;
        }
        if (local.type == NC_RECONNECT) {
            nfound = 0;
            shown = -1;
            long_hint = false;
            t0 = millis();
        }
    }
}

void run_check_host(void) {
    publish_host_label();
    if (settings_has_token()) {
        /* Already paired: go straight to polling, which copes with a sleeping Mac. */
        resolve_host();
        set_state(S_RUNNING);
        return;
    }
    const bool manual = g_settings.host.manual;
    ui_progress("Saying hello", g_settings.host.name);
    for (int attempt = 1;; attempt++) {
        if (resolve_host()) {
            size_t len = 0;
            int code = http_call(s_host_ip, g_settings.host.port, "GET", "/api/v1/health", nullptr, nullptr, s_body,
                                 kBodyCap, &len);
            LOGI("api", "GET /health -> %d", code);
            if (code == 200) {
                JsonDocument doc;
                bool ok = deserializeJson(doc, (const char *)s_body, len) == DeserializationError::Ok;
                const char *service = ok ? (doc["service"] | "") : "";
                int schema = ok ? (doc["schemaVersion"] | 0) : 0;
                if (strcmp(service, "claudette") != 0) {
                    fail_with("That's not Claudette",
                              "Something answered at that address, but it isn't the Claudette app.",
                              manual ? "Change address" : "Search again", manual ? ACT_OPEN_PORTAL : ACT_DISCOVER,
                              S_CHECK_HOST);
                    return;
                }
                if (schema != CL_SCHEMA_VERSION) {
                    LOGI("api", "schema %d, firmware speaks %d", schema, CL_SCHEMA_VERSION);
                    fail_with("Update needed",
                              "Your Mac's Claudette app and this display speak different versions. "
                              "Update both to the latest release.",
                              "Try again", ACT_RETRY, S_CHECK_HOST);
                    return;
                }
                const char *host_name = doc["hostName"] | "";
                if (host_name[0]) util_copy_utf8(g_settings.host.name, sizeof(g_settings.host.name), host_name);
                publish_host_label();
                set_state(S_PAIR);
                return;
            }
        }
        if (attempt >= 3) {
            char body[200];
            snprintf(body, sizeof(body),
                     "%s isn't answering. Is it awake, with the Claudette app running? I'll keep trying.",
                     g_settings.host.name[0] ? g_settings.host.name : "Your Mac");
            fail_with("Can't reach your Mac", body, manual ? "Change address" : "Search again",
                      manual ? ACT_OPEN_PORTAL : ACT_DISCOVER, S_CHECK_HOST, 30000);
            return;
        }
        if (!idle(3000)) return;
    }
}

void run_pair(void) {
    if (!s_host_ip_ok && !resolve_host()) {
        set_state(S_CHECK_HOST);
        return;
    }
    settings_ensure_device_id();

    char secret[33];
    util_random_hex(secret, 16); /* 128-bit pairSecret, only we know it */

    char body[256];
    snprintf(body, sizeof(body),
             "{\"deviceId\":\"%s\",\"deviceName\":\"%s\",\"firmwareVersion\":\"%s\",\"pairSecret\":\"%s\"}",
             g_settings.device_id, s_dev_name, CLAUDETTE_FW_VERSION, secret);

    ui_progress("Asking to pair", g_settings.host.name);
    size_t len = 0;
    int code = http_call(s_host_ip, g_settings.host.port, "POST", "/api/v1/pair/request", body, nullptr, s_body,
                         kBodyCap, &len);
    util_wipe(body, sizeof(body));
    LOGI("pair", "POST /pair/request -> %d", code);

    if (code == 429) {
        util_wipe(secret, sizeof(secret));
        ui_progress("Taking a breather", "Too many pairing tries. I'll ask again in a minute.");
        idle(60000);
        return; /* state unchanged: try again */
    }
    if (code < 200 || code >= 300) {
        util_wipe(secret, sizeof(secret));
        if (code < 0) {
            fail_with("Can't reach your Mac", "The pairing request didn't get through. I'll try again shortly.",
                      "Try again", ACT_RETRY, S_CHECK_HOST, 30000);
        } else {
            char msg[160];
            snprintf(msg, sizeof(msg), "Your Mac said no (HTTP %d). Check the Claudette page on your Mac.", code);
            fail_with("Pairing didn't start", msg, "Try again", ACT_RETRY, S_PAIR);
        }
        return;
    }

    char pairing_id[72] = {0};
    char pin[8] = {0};
    {
        JsonDocument doc;
        if (deserializeJson(doc, (const char *)s_body, len) == DeserializationError::Ok) {
            util_copy_utf8(pairing_id, sizeof(pairing_id), doc["pairingId"] | "");
            util_copy_utf8(pin, sizeof(pin), doc["code"] | "");
        }
    }
    if (!safe_id(pairing_id, 64) || strlen(pin) != 6) {
        util_wipe(secret, sizeof(secret));
        LOGI("pair", "unexpected /pair/request response");
        fail_with("Pairing didn't start", "Your Mac sent something I didn't understand. Is everything up to date?",
                  "Try again", ACT_RETRY, S_PAIR);
        return;
    }

    ui_pairing(g_settings.host.name, pin);
    util_wipe(pin, sizeof(pin));
    LOGI("pair", "code shown, waiting for approval on the Mac");

    char complete[200];
    snprintf(complete, sizeof(complete), "{\"pairingId\":\"%s\",\"pairSecret\":\"%s\"}", pairing_id, secret);
    util_wipe(secret, sizeof(secret));

    /* Requests expire after 5 minutes on the service; give it a little slack. */
    const uint32_t deadline = millis() + 5 * 60 * 1000 + 15000;
    uint32_t wait = 2000;
    for (;;) {
        if (!idle(wait)) {
            util_wipe(complete, sizeof(complete));
            return;
        }
        wait = 2000;
        bool expired = (int32_t)(millis() - deadline) > 0;
        if (!expired) {
            code = http_call(s_host_ip, g_settings.host.port, "POST", "/api/v1/pair/complete", complete, nullptr,
                             s_body, kBodyCap, &len);
            if (code != 200) LOGI("pair", "POST /pair/complete -> %d", code);
            if (code == 200) {
                JsonDocument doc;
                if (deserializeJson(doc, (const char *)s_body, len) != DeserializationError::Ok) continue;
                util_wipe(s_body, len);
                const char *status = doc["status"] | "";
                if (strcmp(status, "pending") == 0) continue;
                if (strcmp(status, "approved") == 0) {
                    const char *token = doc["token"] | "";
                    if (!safe_id(token, sizeof(g_settings.token) - 1) || strlen(token) < 16) {
                        LOGI("pair", "approved but token malformed");
                        util_wipe(complete, sizeof(complete));
                        fail_with("Pairing hiccup", "Your Mac approved, but sent something odd. Let's try again.",
                                  "Try again", ACT_RETRY, S_PAIR);
                        return;
                    }
                    util_copy_utf8(g_settings.token, sizeof(g_settings.token), token);
                    const char *host_id = doc["hostId"] | "";
                    const char *host_name = doc["hostName"] | "";
                    if (host_id[0]) util_copy_utf8(g_settings.host.id, sizeof(g_settings.host.id), host_id);
                    if (host_name[0]) util_copy_utf8(g_settings.host.name, sizeof(g_settings.host.name), host_name);
                    settings_save_host();
                    settings_save_token();
                    util_wipe(complete, sizeof(complete));
                    LOGI("pair", "approved; token stored");
                    publish_host_label();
                    set_state(S_RUNNING);
                    return;
                }
                if (strcmp(status, "denied") == 0) {
                    LOGI("pair", "denied");
                    util_wipe(complete, sizeof(complete));
                    fail_with("Pairing declined", "The request was turned down on your Mac.", "Try again", ACT_RETRY,
                              S_PAIR);
                    return;
                }
                if (strcmp(status, "expired") == 0) expired = true;
            } else if (code == 404 || code == 410) {
                expired = true;
            } else if (code == 429) {
                wait = 6000;
            } else if (code == 400 || code == 401 || code == 403) {
                util_wipe(complete, sizeof(complete));
                fail_with("Pairing didn't work", "Your Mac rejected this pairing request. Let's start over.",
                          "Try again", ACT_RETRY, S_PAIR);
                return;
            }
            /* network errors: keep polling until the deadline */
        }
        if (expired) {
            LOGI("pair", "expired");
            util_wipe(complete, sizeof(complete));
            fail_with("Code expired", "That code timed out before it was entered. Let's get a fresh one.",
                      "New code", ACT_RETRY, S_PAIR);
            return;
        }
    }
}

int toggle_pin(const NetCmd &c) {
    JsonDocument doc;
    JsonObject pin = doc["pins"].to<JsonArray>().add<JsonObject>();
    pin["sessionId"] = c.session_id;
    pin["pinned"] = c.flag;
    char body[160];
    serializeJson(doc, body, sizeof(body));
    size_t len = 0;
    int code = http_call(s_host_ip, g_settings.host.port, "PATCH", "/api/v1/preferences", body, g_settings.token,
                         s_body, kBodyCap, &len);
    LOGI("api", "PATCH /preferences (%s) -> %d", c.flag ? "pin" : "unpin", code);
    return code;
}

void revoked(void) {
    LOGI("api", "401: token revoked, pairing again");
    settings_clear_pairing(false);
    set_state(S_CHECK_HOST);
}

void run_running(void) {
    struct PollingGuard {
        PollingGuard() { bridge_set_polling(true); }
        ~PollingGuard() { bridge_set_polling(false); }
    } guard;

    publish_host_label();
    LOGI("api", "polling %s:%u every %u ms", g_settings.host.addr, g_settings.host.port, CLAUDETTE_POLL_MS);
    ui_progress("Connecting", g_settings.host.name);

    bool dashboard_shown = false;
    uint16_t fails = 0;
    uint32_t next = millis();
    uint32_t last_resolve = 0;
    bool force_resolve = !s_host_ip_ok;
    const uint32_t since = millis();

    for (;;) {
        if (s_wifi_regained) {
            s_wifi_regained = false;
            force_resolve = true; /* we may be on a new subnet / the Mac may have moved */
            next = millis();
        }
        if ((int32_t)(millis() - next) >= 0) {
            if (wifi_up() && (force_resolve || (fails >= 4 && millis() - last_resolve > 30000))) {
                last_resolve = millis();
                force_resolve = false;
                rediscover();
                if (!s_host_ip_ok) resolve_host();
            }

            int code = 0;
            bool ok = false;
            size_t len = 0;
            if (!wifi_up()) {
                code = -1000;
            } else if (!s_host_ip_ok) {
                code = -1001;
            } else {
                code = http_call(s_host_ip, g_settings.host.port, "GET", "/api/v1/status?view=device", nullptr,
                                 g_settings.token, s_body, kBodyCap, &len);
                if (code == 200) {
                    cl_snapshot_t *scratch = bridge_scratch();
                    ok = scratch && cl_model_parse(s_body, len, scratch) && scratch->valid;
                    if (!ok) LOGI("api", "snapshot rejected (%u bytes)", (unsigned)len);
                } else if (code == 401) {
                    revoked();
                    return;
                }
            }

            if (ok) {
                if (!dashboard_shown) {
                    ui_dashboard();
                    dashboard_shown = true;
                }
                bridge_publish_scratch();
                bridge_poll_ok();
                if (fails) LOGI("api", "live again after %u failed polls", fails);
                fails = 0;
            } else {
                if (fails < 0xFFFF) fails++;
                bridge_poll_fail();
                if (fails == 1 || fails % 20 == 0) {
                    if (code == -1000) LOGI("api", "poll skipped: no Wi-Fi");
                    else if (code == -1001) LOGI("api", "poll skipped: host unresolved");
                    else if (code < 0) LOGI("api", "poll failed: %s (%d)", http_err_str(code), code);
                    else if (code != 200) LOGI("api", "poll failed: HTTP %d", code);
                }
                if (!dashboard_shown && millis() - since >= CLAUDETTE_OFFLINE_AFTER_MS) {
                    ui_dashboard(); /* shows "Sleeping" with the link state */
                    dashboard_shown = true;
                }
            }

            uint32_t interval = CLAUDETTE_POLL_MS;
            if (fails > 0) {
                uint32_t shift = fails - 1 > 4 ? 4 : fails - 1;
                interval = CLAUDETTE_POLL_MS << shift;
                if (interval > 30000) interval = 30000;
            }
            int32_t jitter = (int32_t)interval / 6;
            next = millis() + (uint32_t)((int32_t)interval + util_rand_range(-jitter, jitter));
        }

        int32_t remaining = (int32_t)(next - millis());
        if (remaining < 0) remaining = 0;
        NetCmd local;
        if (!idle((uint32_t)remaining, &local)) return;
        if (local.type == NC_TOGGLE_PIN) {
            if (s_host_ip_ok && wifi_up()) {
                int code = toggle_pin(local);
                if (code == 401) {
                    revoked();
                    return;
                }
            }
            next = millis(); /* refresh right away so the UI reflects the change */
        } else if (local.type == NC_RECONNECT) {
            LOGI("api", "reconnect requested");
            force_resolve = true;
            next = millis();
        }
    }
}

void run_wait_user(void) {
    const uint32_t t0 = millis();
    for (;;) {
        if (!idle(500)) return;
        if (s_auto_retry_ms && millis() - t0 >= s_auto_retry_ms) {
            LOGI("net", "auto-retry");
            set_state(s_retry_state);
            return;
        }
    }
}

void net_main(void *) {
    s_body = (char *)heap_caps_malloc(kBodyCap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!s_body) s_body = (char *)malloc(kBodyCap);
    if (!s_body) {
        LOGI("net", "no memory for HTTP buffer");
        vTaskDelete(nullptr);
        return;
    }

    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(s_dev_name, sizeof(s_dev_name), "Claudette-%02X%02X", mac[4], mac[5]);
    snprintf(s_mdns_name, sizeof(s_mdns_name), "claudette-%02x%02x", mac[4], mac[5]);
    LOGI("net", "device %s", s_dev_name);

    s_state = settings_has_wifi() ? S_WIFI : S_PORTAL;
    for (;;) {
        s_state_changed = false;
        switch (s_state) {
            case S_WIFI: run_wifi(); break;
            case S_PORTAL: run_portal(); break;
            case S_DISCOVER: run_discover(); break;
            case S_CHECK_HOST: run_check_host(); break;
            case S_PAIR: run_pair(); break;
            case S_RUNNING: run_running(); break;
            case S_WAIT_USER: run_wait_user(); break;
        }
        vTaskDelay(pdMS_TO_TICKS(10));
    }
}

}  // namespace

void net_task_start(void) {
    /* Core 0 alongside the Wi-Fi stack; the UI/LVGL loop owns core 1. Generous
     * stack: HTTPClient + ArduinoJson + cl_model_parse all live here. */
    xTaskCreatePinnedToCore(net_main, "net", 16384, nullptr, 2, nullptr, 0);
}

const char *net_state_name(void) { return kStateNames[s_state]; }
