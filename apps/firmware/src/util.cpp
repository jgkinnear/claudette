#include "util.h"

#include <esp_random.h>
#include <string.h>

void util_copy_utf8(char *dst, size_t size, const char *src) {
    if (!dst || size == 0) return;
    if (!src) src = "";
    size_t n = strlen(src);
    if (n >= size) {
        n = size - 1;
        /* back up over continuation bytes (10xxxxxx) to a code-point start */
        while (n > 0 && ((uint8_t)src[n] & 0xC0) == 0x80) n--;
    }
    memcpy(dst, src, n);
    dst[n] = '\0';
}

void util_html_escape(String &out, const char *s) {
    if (!s) return;
    for (; *s; s++) {
        switch (*s) {
            case '&': out += F("&amp;"); break;
            case '<': out += F("&lt;"); break;
            case '>': out += F("&gt;"); break;
            case '"': out += F("&quot;"); break;
            case '\'': out += F("&#39;"); break;
            default:
                if ((uint8_t)*s >= 0x20 || *s == '\t') out += *s;
                break;
        }
    }
}

void util_random_hex(char *out, size_t len) {
    static const char hex[] = "0123456789abcdef";
    for (size_t i = 0; i < len; i++) {
        uint8_t b = (uint8_t)(esp_random() & 0xFF);
        out[2 * i] = hex[b >> 4];
        out[2 * i + 1] = hex[b & 0x0F];
    }
    out[2 * len] = '\0';
}

int32_t util_rand_range(int32_t lo, int32_t hi) {
    if (hi <= lo) return lo;
    uint32_t span = (uint32_t)(hi - lo) + 1u;
    return lo + (int32_t)(esp_random() % span);
}

void util_friendly_password(char *out, size_t size) {
    static const char cons[] = "bdfghjkmnprstvz";  /* 15, no look-alikes */
    static const char vow[] = "aeiou";
    char buf[16];
    size_t p = 0;
    for (int w = 0; w < 3; w++) {
        if (w) buf[p++] = '-';
        for (int k = 0; k < 2; k++) {
            buf[p++] = cons[esp_random() % (sizeof(cons) - 1)];
            buf[p++] = vow[esp_random() % (sizeof(vow) - 1)];
        }
    }
    buf[p] = '\0';
    strncpy(out, buf, size - 1);
    out[size - 1] = '\0';
}

void util_wipe(void *p, size_t n) {
    volatile uint8_t *v = (volatile uint8_t *)p;
    while (n--) *v++ = 0;
}
