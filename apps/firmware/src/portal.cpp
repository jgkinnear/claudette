#include "portal.h"

#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>
#include <string.h>
#include <strings.h>

#include "board_config.h"
#include "log.h"
#include "settings.h"
#include "util.h"

namespace {

const IPAddress kApIp(192, 168, 4, 1);
const IPAddress kApMask(255, 255, 255, 0);

struct Net {
    char ssid[33];
    int8_t rssi;
    bool secure;
};
const int kMaxNets = 20;
Net s_nets[kMaxNets];
int s_net_count;

WebServer *s_server;
DNSServer *s_dns;
bool s_saved;
char s_ap_name[33];

/* Shared look: dark navy, cream text, terracotta accents (matches the device UI). */
const char kHead[] PROGMEM = R"HTML(<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claudette setup</title><style>
:root{--bg:#1B2333;--card:#243047;--line:#34415c;--fg:#F5EBDD;--mute:#b9b0a4;--acc:#D97757}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 -apple-system,system-ui,Segoe UI,Roboto,sans-serif}
main{max-width:440px;margin:0 auto;padding:24px 16px 40px}
h1{font-size:26px;margin:8px 0 2px}h2{font-size:15px;color:var(--mute);font-weight:600;margin:22px 0 8px;text-transform:uppercase;letter-spacing:.06em}
.sub{color:var(--mute);margin:0 0 8px}.face{font-size:34px;color:var(--acc);letter-spacing:2px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px}
.nets{display:flex;flex-direction:column;gap:6px;max-height:300px;overflow:auto}
.net{display:flex;justify-content:space-between;align-items:center;width:100%;background:transparent;color:var(--fg);border:1px solid var(--line);border-radius:12px;padding:11px 12px;font:inherit;text-align:left;cursor:pointer}
.net:active,.net.on{border-color:var(--acc);background:#2c3956}.net small{color:var(--mute);white-space:nowrap;margin-left:8px}
label{display:block;margin:12px 0 4px;color:var(--mute);font-size:14px}
input[type=text],input[type=password],input:not([type]){width:100%;padding:12px;border-radius:12px;border:1px solid var(--line);background:#141b28;color:var(--fg);font:inherit}
input:focus{outline:2px solid var(--acc);border-color:transparent}
.row{display:flex;gap:10px}.row>div{flex:1}.row>div.port{flex:0 0 96px}
.chk{display:flex;gap:8px;align-items:center;margin-top:8px}
details{margin-top:18px}summary{cursor:pointer;color:var(--acc);font-weight:600}
.go{display:block;width:100%;margin-top:22px;padding:14px;border:0;border-radius:14px;background:var(--acc);color:#1B2333;font:inherit;font-weight:700;font-size:17px;cursor:pointer}
a{color:var(--acc)}.err{background:#4a2a2a;border:1px solid #c0675a;border-radius:12px;padding:10px 12px;margin:12px 0}
.foot{color:var(--mute);font-size:13px;margin-top:28px;text-align:center}.hint{color:var(--mute);font-size:14px}
</style></head><body><main>)HTML";

const char kFoot[] PROGMEM = R"HTML(</main><script>
document.querySelectorAll('.net').forEach(function(b){b.onclick=function(){
document.querySelectorAll('.net').forEach(function(o){o.classList.remove('on')});b.classList.add('on');
var s=document.getElementById('ssid');s.value=b.getAttribute('data-s');document.getElementById('pass').focus();}});
</script></body></html>)HTML";

void scan_networks(void) {
    s_net_count = 0;
    int n = WiFi.scanNetworks(false, false);
    if (n < 0) n = 0;
    for (int i = 0; i < n; i++) {
        String ssid = WiFi.SSID(i);
        if (ssid.length() == 0 || ssid.length() > 32) continue;
        int8_t rssi = (int8_t)WiFi.RSSI(i);
        bool secure = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
        int found = -1;
        for (int k = 0; k < s_net_count; k++) {
            if (strcmp(s_nets[k].ssid, ssid.c_str()) == 0) {
                found = k;
                break;
            }
        }
        if (found >= 0) {
            if (rssi > s_nets[found].rssi) s_nets[found].rssi = rssi;
            continue;
        }
        if (s_net_count >= kMaxNets) continue;
        Net &e = s_nets[s_net_count++];
        strncpy(e.ssid, ssid.c_str(), sizeof(e.ssid) - 1);
        e.ssid[sizeof(e.ssid) - 1] = '\0';
        e.rssi = rssi;
        e.secure = secure;
    }
    WiFi.scanDelete();
    /* strongest first */
    for (int i = 1; i < s_net_count; i++) {
        Net t = s_nets[i];
        int j = i - 1;
        while (j >= 0 && s_nets[j].rssi < t.rssi) {
            s_nets[j + 1] = s_nets[j];
            j--;
        }
        s_nets[j + 1] = t;
    }
    LOGI("setup", "scan: %d networks", s_net_count);
}

const char *bars(int8_t rssi) {
    if (rssi >= -55) return "strong";
    if (rssi >= -67) return "good";
    if (rssi >= -78) return "fair";
    return "weak";
}

void send_page(const char *error, const char *ssid_value, const char *host_value, uint16_t port_value) {
    String html;
    html.reserve(6144);
    html += FPSTR(kHead);
    html += F("<div class=\"face\">( ^ &#9697; ^ )</div><h1>Hello! I'm Claudette.</h1>"
              "<p class=\"sub\">Let's get me onto your Wi-Fi. I'll only use it to talk to the "
              "Claudette app on your Mac.</p>");
    if (error && error[0]) {
        html += F("<div class=\"err\">");
        util_html_escape(html, error);
        html += F("</div>");
    }
    html += F("<form method=\"post\" action=\"/save\" autocomplete=\"off\"><h2>Your network</h2><div class=\"card\">");
    if (s_net_count == 0) {
        html += F("<p class=\"hint\">No networks found nearby. You can still type the name below.</p>");
    } else {
        html += F("<div class=\"nets\">");
        for (int i = 0; i < s_net_count; i++) {
            html += F("<button type=\"button\" class=\"net\" data-s=\"");
            util_html_escape(html, s_nets[i].ssid);
            html += F("\"><span>");
            util_html_escape(html, s_nets[i].ssid);
            html += F("</span><small>");
            html += bars(s_nets[i].rssi);
            if (!s_nets[i].secure) html += F(" &middot; open");
            html += F("</small></button>");
        }
        html += F("</div>");
    }
    html += F("<p class=\"hint\"><a href=\"http://192.168.4.1/?rescan=1\">Scan again</a></p>"
              "<label for=\"ssid\">Network name</label><input id=\"ssid\" name=\"ssid\" maxlength=\"32\" required "
              "autocapitalize=\"none\" autocorrect=\"off\" spellcheck=\"false\" value=\"");
    util_html_escape(html, ssid_value);
    html += F("\"><label for=\"pass\">Password</label><input id=\"pass\" name=\"pass\" type=\"password\" maxlength=\"63\"");
    if (g_settings.ssid[0]) html += F(" placeholder=\"Leave blank to keep the saved one\"");
    html += F("><label class=\"chk\"><input type=\"checkbox\" onclick=\"var p=document.getElementById('pass');"
              "p.type=this.checked?'text':'password'\"> Show password</label></div>"
              "<details");
    if (host_value && host_value[0]) html += F(" open");
    html += F("><summary>Can't find your Mac automatically?</summary><div class=\"card\" style=\"margin-top:10px\">"
              "<p class=\"hint\">Office and guest networks often block discovery. Type your Mac's address "
              "(the Claudette page on your Mac shows it). Leave blank to find it automatically.</p>"
              "<div class=\"row\"><div><label for=\"host\">Mac address or hostname</label>"
              "<input id=\"host\" name=\"host\" maxlength=\"63\" autocapitalize=\"none\" autocorrect=\"off\" "
              "spellcheck=\"false\" placeholder=\"192.168.1.20 or my-mac.local\" value=\"");
    util_html_escape(html, host_value);
    html += F("\"></div><div class=\"port\"><label for=\"port\">Port</label><input id=\"port\" name=\"port\" "
              "inputmode=\"numeric\" maxlength=\"5\" value=\"");
    html += String(port_value ? port_value : CLAUDETTE_DEFAULT_PORT);
    html += F("\"></div></div></div></details><button class=\"go\" type=\"submit\">Save &amp; connect</button></form>"
              "<p class=\"foot\">Claudette " CLAUDETTE_FW_VERSION " &middot; ");
    util_html_escape(html, s_ap_name);
    html += F("</p>");
    html += FPSTR(kFoot);
    s_server->sendHeader("Cache-Control", "no-store");
    s_server->send(200, "text/html; charset=utf-8", html);
}

void send_current_page(const char *error) {
    const char *host = g_settings.host.manual ? g_settings.host.addr : "";
    uint16_t port = g_settings.host.manual ? g_settings.host.port : CLAUDETTE_DEFAULT_PORT;
    send_page(error, g_settings.ssid, host, port);
}

/* Bring-up visibility: one line per request (path only — never query strings or bodies). */
void log_request(const char *what) {
    LOGI("setup", "http %s %s from %s -> %s", s_server->method() == HTTP_POST ? "POST" : "GET",
         s_server->uri().c_str(), s_server->client().remoteIP().toString().c_str(), what);
}

void redirect_home(void) {
    log_request("redirect");
    s_server->sendHeader("Location", String("http://") + kApIp.toString() + "/", true);
    s_server->sendHeader("Cache-Control", "no-store");
    s_server->send(302, "text/plain", "");
}

bool valid_host(const String &h) {
    if (h.length() == 0 || h.length() > 63) return false;
    for (size_t i = 0; i < h.length(); i++) {
        char c = h[i];
        if (!(isalnum((unsigned char)c) || c == '.' || c == '-' || c == '_')) return false;
    }
    return true;
}

void handle_root(void) {
    log_request("page");
    /* Captive-portal browsers ask for random hosts: bounce them to our IP. */
    if (s_server->hostHeader() != kApIp.toString()) {
        redirect_home();
        return;
    }
    if (s_server->hasArg("rescan")) scan_networks();
    send_current_page(nullptr);
}

void handle_save(void) {
    String ssid = s_server->arg("ssid");
    String pass = s_server->arg("pass");
    String host = s_server->arg("host");
    String port_s = s_server->arg("port");
    host.trim();
    port_s.trim();

    /* Accept pasted URLs like "http://192.168.1.20:3333/". */
    if (host.startsWith("http://")) host.remove(0, 7);
    int slash = host.indexOf('/');
    if (slash >= 0) host.remove(slash);
    int colon = host.indexOf(':');
    if (colon >= 0) {
        port_s = host.substring(colon + 1);
        host.remove(colon);
    }
    long port = port_s.length() ? port_s.toInt() : CLAUDETTE_DEFAULT_PORT;

    const char *err = nullptr;
    bool keep_pass = pass.length() == 0 && g_settings.ssid[0] && ssid == g_settings.ssid;
    if (ssid.length() == 0 || ssid.length() > 32) {
        err = "Please choose a network (names are up to 32 characters).";
    } else if (!keep_pass && pass.length() > 0 && (pass.length() < 8 || pass.length() > 63)) {
        err = "Wi-Fi passwords are 8 to 63 characters.";
    } else if (host.length() && !valid_host(host)) {
        err = "That Mac address doesn't look right. Use an IP like 192.168.1.20 or a name like my-mac.local.";
    } else if (port < 1 || port > 65535) {
        err = "The port should be a number like 3333.";
    }
    if (err) {
        LOGI("setup", "form rejected");
        send_page(err, ssid.c_str(), host.c_str(), (uint16_t)(port > 0 && port < 65536 ? port : 0));
        util_wipe((void *)pass.c_str(), pass.length());
        return;
    }

    strncpy(g_settings.ssid, ssid.c_str(), sizeof(g_settings.ssid) - 1);
    g_settings.ssid[sizeof(g_settings.ssid) - 1] = '\0';
    if (!keep_pass) {
        util_wipe(g_settings.pass, sizeof(g_settings.pass));
        strncpy(g_settings.pass, pass.c_str(), sizeof(g_settings.pass) - 1);
    }
    util_wipe((void *)pass.c_str(), pass.length());
    settings_save_wifi();

    if (host.length()) {
        bool changed = !g_settings.host.manual || strcasecmp(g_settings.host.addr, host.c_str()) != 0 ||
                       g_settings.host.port != (uint16_t)port;
        if (changed) {
            /* A token belongs to the host that issued it: never send it elsewhere. */
            settings_clear_pairing(true);
            memset(&g_settings.host, 0, sizeof(g_settings.host));
            util_copy_utf8(g_settings.host.addr, sizeof(g_settings.host.addr), host.c_str());
            util_copy_utf8(g_settings.host.name, sizeof(g_settings.host.name), host.c_str());
            g_settings.host.port = (uint16_t)port;
            g_settings.host.manual = true;
            settings_save_host();
        }
    } else if (g_settings.host.manual) {
        settings_clear_pairing(true);
    }

    LOGI("setup", "saved Wi-Fi \"%s\"%s", g_settings.ssid, host.length() ? " + manual host" : "");
    s_saved = true;

    String html;
    html.reserve(2048);
    html += FPSTR(kHead);
    html += F("<div class=\"face\">( ^ &#9697; ^ )</div><h1>Thank you!</h1><div class=\"card\"><p>I'm restarting and "
              "joining <b>");
    util_html_escape(html, g_settings.ssid);
    html += F("</b>. Watch my screen: if all goes well I'll start looking for your Mac.</p>"
              "<p class=\"hint\">You can reconnect this phone to your usual Wi-Fi now.</p></div>");
    html += FPSTR(kFoot);
    s_server->sendHeader("Cache-Control", "no-store");
    s_server->send(200, "text/html; charset=utf-8", html);
}

}  // namespace

bool portal_start(const char *ap_name, const char *ap_password) {
    s_saved = false;
    strncpy(s_ap_name, ap_name, sizeof(s_ap_name) - 1);
    s_ap_name[sizeof(s_ap_name) - 1] = '\0';

    WiFi.mode(WIFI_AP_STA);
    /* Scan before the AP is up so nobody connected gets kicked by channel hops. */
    scan_networks();

    if (!WiFi.softAP(ap_name, ap_password, 1, 0, 4)) {
        LOGI("setup", "softAP start failed");
        return false;
    }
    delay(100);
    if (!WiFi.softAPConfig(kApIp, kApIp, kApMask)) LOGI("setup", "softAPConfig failed");
    LOGI("setup", "AP ip %s", WiFi.softAPIP().toString().c_str());

    static bool events;
    if (!events) {
        events = true;
        WiFi.onEvent([](arduino_event_id_t, arduino_event_info_t) { LOGI("setup", "phone joined the hotspot"); },
                     ARDUINO_EVENT_WIFI_AP_STACONNECTED);
        WiFi.onEvent([](arduino_event_id_t, arduino_event_info_t info) {
            LOGI("setup", "gave phone address %s", IPAddress(info.wifi_ap_staipassigned.ip.addr).toString().c_str());
        }, ARDUINO_EVENT_WIFI_AP_STAIPASSIGNED);
        WiFi.onEvent([](arduino_event_id_t, arduino_event_info_t) { LOGI("setup", "phone left the hotspot"); },
                     ARDUINO_EVENT_WIFI_AP_STADISCONNECTED);
    }

    s_dns = new DNSServer();
    s_dns->setErrorReplyCode(DNSReplyCode::NoError);
    s_dns->start(53, "*", kApIp);

    s_server = new WebServer(80);
    s_server->on("/", HTTP_GET, handle_root);
    s_server->on("/save", HTTP_POST, handle_save);
    /* OS captive-portal probes: Apple wants a non-"Success" page, Android/Windows a redirect. */
    s_server->on("/hotspot-detect.html", HTTP_GET, [] { send_current_page(nullptr); });
    s_server->on("/library/test/success.html", HTTP_GET, [] { send_current_page(nullptr); });
    s_server->on("/generate_204", HTTP_GET, redirect_home);
    s_server->on("/gen_204", HTTP_GET, redirect_home);
    s_server->on("/connecttest.txt", HTTP_GET, redirect_home);
    s_server->on("/ncsi.txt", HTTP_GET, redirect_home);
    s_server->on("/favicon.ico", HTTP_GET, [] { s_server->send(204); });
    s_server->onNotFound(redirect_home);
    s_server->begin();

    LOGI("setup", "portal up: AP \"%s\" at http://%s", ap_name, kApIp.toString().c_str());
    return true;
}

void portal_loop(void) {
    if (s_dns) s_dns->processNextRequest();
    if (s_server) s_server->handleClient();
}

void portal_stop(void) {
    if (s_server) {
        s_server->stop();
        delete s_server;
        s_server = nullptr;
    }
    if (s_dns) {
        s_dns->stop();
        delete s_dns;
        s_dns = nullptr;
    }
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    LOGI("setup", "portal closed");
}

bool portal_saved(void) { return s_saved; }

int portal_clients(void) { return WiFi.softAPgetStationNum(); }
