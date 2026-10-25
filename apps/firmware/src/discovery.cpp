#include "discovery.h"

#include <ESPmDNS.h>
#include <WiFi.h>
#include <mdns.h>
#include <string.h>
#include <strings.h>

#include "log.h"
#include "util.h"

static bool s_started;

bool discovery_begin(const char *own_hostname) {
    if (s_started) return true;
    if (!MDNS.begin(own_hostname)) {
        LOGI("mdns", "responder start failed");
        return false;
    }
    s_started = true;
    return true;
}

static const char *txt_get(const mdns_result_t *r, const char *key) {
    for (size_t i = 0; i < r->txt_count; i++) {
        if (r->txt[i].key && strcasecmp(r->txt[i].key, key) == 0) {
            return r->txt[i].value ? r->txt[i].value : "";
        }
    }
    return nullptr;
}

static bool first_ipv4(const mdns_result_t *r, IPAddress *out) {
    for (const mdns_ip_addr_t *a = r->addr; a; a = a->next) {
        if (a->addr.type == ESP_IPADDR_TYPE_V4 && a->addr.u_addr.ip4.addr != 0) {
            *out = IPAddress(a->addr.u_addr.ip4.addr);
            return true;
        }
    }
    return false;
}

static void strip_local(char *name) {
    size_t n = strlen(name);
    if (n > 6 && strcasecmp(name + n - 6, ".local") == 0) name[n - 6] = '\0';
}

int discovery_query(DiscoveredHost *out, int max) {
    if (!s_started || max <= 0) return 0;
    mdns_result_t *results = nullptr;
    esp_err_t err = mdns_query_ptr("_claudette", "_tcp", 3000, 20, &results);
    if (err != ESP_OK) {
        LOGI("mdns", "query failed (%d)", (int)err);
        return 0;
    }
    int n = 0;
    for (mdns_result_t *r = results; r && n < max; r = r->next) {
        if (!r->hostname && !r->instance_name) continue;
        if (r->port == 0) continue;

        DiscoveredHost h;
        memset(&h, 0, sizeof(h));
        h.port = r->port;
        util_copy_utf8(h.mdns, sizeof(h.mdns), r->hostname ? r->hostname : "");
        strip_local(h.mdns);

        const char *txt_name = txt_get(r, "name");
        const char *txt_id = txt_get(r, "id");
        if (txt_name && txt_name[0]) {
            util_copy_utf8(h.name, sizeof(h.name), txt_name);
        } else if (r->instance_name && r->instance_name[0]) {
            util_copy_utf8(h.name, sizeof(h.name), r->instance_name);
        } else {
            util_copy_utf8(h.name, sizeof(h.name), h.mdns);
        }
        if (txt_id) util_copy_utf8(h.id, sizeof(h.id), txt_id);

        IPAddress ip;
        if (!first_ipv4(r, &ip)) {
            /* PTR answer without an A record in the additional section. */
            if (!h.mdns[0] || !discovery_resolve(h.mdns, &ip)) continue;
        }
        snprintf(h.addr, sizeof(h.addr), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);

        /* The same service shows up once per interface / address family. */
        bool dup = false;
        for (int i = 0; i < n; i++) {
            if (out[i].port == h.port &&
                (strcmp(out[i].addr, h.addr) == 0 ||
                 (h.mdns[0] && strcasecmp(out[i].mdns, h.mdns) == 0))) {
                dup = true;
                break;
            }
        }
        if (!dup) out[n++] = h;
    }
    if (results) mdns_query_results_free(results);
    return n;
}

bool discovery_resolve(const char *host, IPAddress *out) {
    if (!host || !host[0]) return false;
    if (out->fromString(host)) return true;

    char name[64];
    util_copy_utf8(name, sizeof(name), host);
    size_t n = strlen(name);
    bool is_local = n > 6 && strcasecmp(name + n - 6, ".local") == 0;
    bool bare = strchr(name, '.') == nullptr;  /* "jasons-mbp" -> try mDNS too */

    if ((is_local || bare) && s_started) {
        if (is_local) name[n - 6] = '\0';
        esp_ip4_addr_t addr;
        addr.addr = 0;
        if (mdns_query_a(name, 2000, &addr) == ESP_OK && addr.addr != 0) {
            *out = IPAddress(addr.addr);
            return true;
        }
        if (is_local) return false;
    }
    IPAddress ip;
    if (WiFi.hostByName(host, ip) == 1 && (uint32_t)ip != 0) {
        *out = ip;
        return true;
    }
    return false;
}
