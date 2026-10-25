#include "http_api.h"

#include <HTTPClient.h>
#include <WiFi.h>
#include <string.h>

#include "board_config.h"

static const uint32_t kTimeoutMs = 3000;

int http_call(const IPAddress &ip, uint16_t port, const char *method, const char *path,
              const char *json_body, const char *bearer, char *buf, size_t cap, size_t *out_len) {
    if (out_len) *out_len = 0;
    if (buf && cap) buf[0] = '\0';

    WiFiClient client;
    HTTPClient http;
    http.setReuse(false);
    /* HTTP/1.0: the server can't use chunked encoding, so the body is either
     * Content-Length bytes or "until close" — both easy to bound. */
    http.useHTTP10(true);
    http.setConnectTimeout(kTimeoutMs);
    http.setTimeout(kTimeoutMs);
    http.setUserAgent("Claudette/" CLAUDETTE_FW_VERSION);

    if (!http.begin(client, ip.toString(), port, path)) return HTTP_ERR_BEGIN;
    http.addHeader("Accept", "application/json");
    if (bearer && bearer[0]) {
        String auth = "Bearer ";
        auth += bearer;
        http.addHeader("Authorization", auth);
        auth.clear();
    }

    int code;
    if (json_body) {
        http.addHeader("Content-Type", "application/json");
        code = http.sendRequest(method, (uint8_t *)json_body, strlen(json_body));
    } else {
        code = http.sendRequest(method);
    }
    if (code <= 0) {
        http.end();
        return code < 0 ? code : HTTP_ERR_BEGIN;
    }

    const int len = http.getSize(); /* -1 when the server didn't say */
    if (!buf || cap < 2) {
        http.end();
        return code;
    }
    if (len > 0 && (size_t)len > cap - 1) {
        http.end();
        return HTTP_ERR_TOO_LARGE;
    }

    WiFiClient *s = http.getStreamPtr();
    size_t got = 0;
    uint32_t last = millis();
    int result = code;
    while (s) {
        if (len >= 0 && got >= (size_t)len) break;
        int avail = s->available();
        if (avail > 0) {
            if (got >= cap - 1) {
                result = HTTP_ERR_TOO_LARGE;
                break;
            }
            size_t want = (size_t)avail;
            if (want > cap - 1 - got) want = cap - 1 - got;
            int r = s->read((uint8_t *)buf + got, want);
            if (r > 0) {
                got += (size_t)r;
                last = millis();
            }
        } else if (!s->connected()) {
            break;
        } else if (millis() - last > kTimeoutMs) {
            result = HTTP_ERR_TRUNCATED;
            break;
        } else {
            delay(2);
        }
    }
    if (result > 0 && len >= 0 && got < (size_t)len) result = HTTP_ERR_TRUNCATED;
    buf[got] = '\0';
    if (out_len) *out_len = got;
    http.end();
    return result;
}

const char *http_err_str(int code) {
    switch (code) {
        case HTTP_ERR_BEGIN: return "bad request setup";
        case HTTP_ERR_TOO_LARGE: return "response too large";
        case HTTP_ERR_TRUNCATED: return "response cut short";
        case HTTPC_ERROR_CONNECTION_REFUSED: return "connection refused";
        case HTTPC_ERROR_SEND_HEADER_FAILED:
        case HTTPC_ERROR_SEND_PAYLOAD_FAILED: return "send failed";
        case HTTPC_ERROR_NOT_CONNECTED: return "not connected";
        case HTTPC_ERROR_CONNECTION_LOST: return "connection lost";
        case HTTPC_ERROR_READ_TIMEOUT: return "timeout";
        default: return "network error";
    }
}
