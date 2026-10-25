/**
 * Snapshot JSON → cl_snapshot_t. Strict, bounded and allocation-free apart
 * from one token buffer that is allocated once and reused.
 */
#include "cl_model.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define JSMN_STATIC
#define JSMN_STRICT
#include "jsmn.h"

#define CL_MAX_TOKENS 4096

typedef struct {
    const char *js;
    const jsmntok_t *t;
    int n;
} parser_t;

/* ------------------------------------------------------------------ text */

void cl_copy_utf8(char *dst, size_t size, const char *src, size_t src_len)
{
    if (size == 0) return;
    if (src_len < size) {
        memcpy(dst, src, src_len);
        dst[src_len] = '\0';
        return;
    }
    /* Leave room for "…" (3 bytes) + NUL, and never split a code point. */
    size_t cut = size > 4 ? size - 4 : 0;
    while (cut > 0 && ((unsigned char)src[cut] & 0xC0) == 0x80) cut--;
    memcpy(dst, src, cut);
    if (size >= 4) {
        memcpy(dst + cut, "\xE2\x80\xA6", 3);
        dst[cut + 3] = '\0';
    } else {
        dst[cut] = '\0';
    }
}

static size_t put_utf8(char *out, uint32_t cp)
{
    if (cp < 0x80) { out[0] = (char)cp; return 1; }
    if (cp < 0x800) {
        out[0] = (char)(0xC0 | (cp >> 6));
        out[1] = (char)(0x80 | (cp & 0x3F));
        return 2;
    }
    if (cp < 0x10000) {
        out[0] = (char)(0xE0 | (cp >> 12));
        out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
        out[2] = (char)(0x80 | (cp & 0x3F));
        return 3;
    }
    out[0] = (char)(0xF0 | (cp >> 18));
    out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
    out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
    out[3] = (char)(0x80 | (cp & 0x3F));
    return 4;
}

static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static bool read_u16(const char *p, const char *end, uint32_t *out)
{
    if (end - p < 4) return false;
    uint32_t v = 0;
    for (int i = 0; i < 4; i++) {
        int h = hexval(p[i]);
        if (h < 0) return false;
        v = (v << 4) | (uint32_t)h;
    }
    *out = v;
    return true;
}

/* Unescape a JSON string token into dst (bounded, UTF-8 safe truncation).
 * Control characters are replaced with spaces so names can't break layout. */
static void copy_json_string(const parser_t *p, int i, char *dst, size_t size)
{
    char buf[160];
    size_t n = 0;
    const char *s = p->js + p->t[i].start;
    const char *end = p->js + p->t[i].end;
    while (s < end && n < sizeof(buf) - 4) {
        char c = *s++;
        if (c != '\\') {
            buf[n++] = ((unsigned char)c < 0x20) ? ' ' : c;
            continue;
        }
        if (s >= end) break;
        char e = *s++;
        switch (e) {
        case 'n': case 'r': case 't': case 'b': case 'f': buf[n++] = ' '; break;
        case 'u': {
            uint32_t cp;
            if (!read_u16(s, end, &cp)) { s = end; break; }
            s += 4;
            if (cp >= 0xD800 && cp <= 0xDBFF && end - s >= 6 && s[0] == '\\' && s[1] == 'u') {
                uint32_t lo;
                if (read_u16(s + 2, end, &lo) && lo >= 0xDC00 && lo <= 0xDFFF) {
                    cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                    s += 6;
                }
            }
            if (cp < 0x20 || (cp >= 0xD800 && cp <= 0xDFFF)) cp = ' ';
            n += put_utf8(buf + n, cp);
            break;
        }
        default: buf[n++] = e; break; /* \" \\ \/ */
        }
    }
    cl_copy_utf8(dst, size, buf, n);
}

/* ------------------------------------------------------------------ time */

static int64_t days_from_civil(int64_t y, unsigned m, unsigned d)
{
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = (unsigned)(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (int64_t)doe - 719468;
}

static bool digits(const char *s, int n, int *out)
{
    int v = 0;
    for (int i = 0; i < n; i++) {
        if (s[i] < '0' || s[i] > '9') return false;
        v = v * 10 + (s[i] - '0');
    }
    *out = v;
    return true;
}

bool cl_parse_iso8601(const char *s, size_t len, int64_t *out_epoch_s)
{
    int Y, M, D, h, m, sec;
    if (len < 19) return false;
    if (!digits(s, 4, &Y) || s[4] != '-' || !digits(s + 5, 2, &M) || s[7] != '-' ||
        !digits(s + 8, 2, &D) || (s[10] != 'T' && s[10] != ' ') || !digits(s + 11, 2, &h) ||
        s[13] != ':' || !digits(s + 14, 2, &m) || s[16] != ':' || !digits(s + 17, 2, &sec))
        return false;
    if (M < 1 || M > 12 || D < 1 || D > 31 || h > 23 || m > 59 || sec > 60) return false;
    size_t i = 19;
    if (i < len && s[i] == '.') {
        i++;
        while (i < len && s[i] >= '0' && s[i] <= '9') i++;
    }
    int offset = 0;
    if (i < len && (s[i] == '+' || s[i] == '-')) {
        int oh, om;
        if (len - i < 6 || !digits(s + i + 1, 2, &oh) || s[i + 3] != ':' || !digits(s + i + 4, 2, &om))
            return false;
        offset = (oh * 3600 + om * 60) * (s[i] == '-' ? -1 : 1);
    } else if (i < len && s[i] != 'Z') {
        return false;
    }
    *out_epoch_s = days_from_civil(Y, (unsigned)M, (unsigned)D) * 86400 + h * 3600 + m * 60 + sec - offset;
    return true;
}

/* ------------------------------------------------------------------ tokens */

static int skip(const parser_t *p, int i)
{
    if (i >= p->n) return p->n;
    const jsmntok_t *t = &p->t[i];
    int j = i + 1;
    if (t->type == JSMN_OBJECT) {
        for (int k = 0; k < t->size; k++) j = skip(p, skip(p, j));
    } else if (t->type == JSMN_ARRAY) {
        for (int k = 0; k < t->size; k++) j = skip(p, j);
    }
    return j;
}

static bool tok_is(const parser_t *p, int i, const char *s)
{
    const jsmntok_t *t = &p->t[i];
    size_t len = (size_t)(t->end - t->start);
    return t->type == JSMN_STRING && strlen(s) == len && memcmp(p->js + t->start, s, len) == 0;
}

/* Value token of `key` in object `obj`, or -1. */
static int get(const parser_t *p, int obj, const char *key)
{
    if (obj < 0 || obj >= p->n || p->t[obj].type != JSMN_OBJECT) return -1;
    int j = obj + 1;
    for (int k = 0; k < p->t[obj].size && j < p->n; k++) {
        if (tok_is(p, j, key)) return j + 1;
        j = skip(p, j + 1);
    }
    return -1;
}

static bool is_null(const parser_t *p, int i)
{
    return i < 0 || (p->t[i].type == JSMN_PRIMITIVE && p->js[p->t[i].start] == 'n');
}

static bool get_bool(const parser_t *p, int obj, const char *key)
{
    int i = get(p, obj, key);
    return i >= 0 && p->t[i].type == JSMN_PRIMITIVE && p->js[p->t[i].start] == 't';
}

static bool get_number(const parser_t *p, int obj, const char *key, double *out)
{
    int i = get(p, obj, key);
    if (is_null(p, i) || p->t[i].type != JSMN_PRIMITIVE) return false;
    char buf[32];
    int len = p->t[i].end - p->t[i].start;
    if (len <= 0 || len >= (int)sizeof(buf)) return false;
    memcpy(buf, p->js + p->t[i].start, (size_t)len);
    buf[len] = '\0';
    char *end;
    *out = strtod(buf, &end);
    return end != buf;
}

static int64_t get_i64(const parser_t *p, int obj, const char *key)
{
    double v;
    return get_number(p, obj, key, &v) && v >= 0 ? (int64_t)v : CL_UNKNOWN;
}

static void get_string(const parser_t *p, int obj, const char *key, char *dst, size_t size)
{
    int i = get(p, obj, key);
    if (i < 0 || p->t[i].type != JSMN_STRING) {
        dst[0] = '\0';
        return;
    }
    copy_json_string(p, i, dst, size);
}

/* Seconds between generatedAt and the timestamp at obj.key (>= 0), or CL_UNKNOWN. */
static int32_t get_age(const parser_t *p, int obj, const char *key, int64_t now)
{
    int i = get(p, obj, key);
    if (i < 0 || p->t[i].type != JSMN_STRING) return CL_UNKNOWN;
    int64_t ts;
    if (!cl_parse_iso8601(p->js + p->t[i].start, (size_t)(p->t[i].end - p->t[i].start), &ts)) return CL_UNKNOWN;
    int64_t age = now - ts;
    if (age < 0) age = 0;
    if (age > INT32_MAX) age = INT32_MAX;
    return (int32_t)age;
}

static cl_state_t parse_state(const parser_t *p, int i)
{
    if (i < 0) return CL_STATE_UNKNOWN;
    if (tok_is(p, i, "working")) return CL_STATE_WORKING;
    if (tok_is(p, i, "needs_attention")) return CL_STATE_NEEDS_ATTENTION;
    if (tok_is(p, i, "ready")) return CL_STATE_READY;
    if (tok_is(p, i, "failed")) return CL_STATE_FAILED;
    if (tok_is(p, i, "stopped")) return CL_STATE_STOPPED;
    return CL_STATE_UNKNOWN;
}

static void parse_rate(const parser_t *p, int obj, const char *key, int64_t now, cl_rate_window_t *w)
{
    memset(w, 0, sizeof(*w));
    int i = get(p, obj, key);
    double pct;
    if (is_null(p, i) || !get_number(p, i, "usedPercent", &pct)) return;
    w->present = true;
    w->used_pct = (int8_t)(pct < 0 ? 0 : pct > 100 ? 100 : pct + 0.5);
    int32_t age = CL_UNKNOWN;
    int r = get(p, i, "resetsAt");
    int64_t ts;
    if (r >= 0 && p->t[r].type == JSMN_STRING &&
        cl_parse_iso8601(p->js + p->t[r].start, (size_t)(p->t[r].end - p->t[r].start), &ts)) {
        int64_t in = ts - now;
        age = (int32_t)(in < 0 ? 0 : in > INT32_MAX ? INT32_MAX : in);
    }
    w->resets_in_s = age;
}

static void parse_session(const parser_t *p, int o, int64_t now, cl_session_t *s)
{
    memset(s, 0, sizeof(*s));
    get_string(p, o, "id", s->id, sizeof(s->id));
    get_string(p, o, "displayName", s->name, sizeof(s->name));
    int kind = get(p, o, "kind");
    s->background = kind >= 0 && tok_is(p, kind, "background");
    s->pinned = get_bool(p, o, "pinned");
    double po;
    s->pin_order = (int8_t)(get_number(p, o, "pinOrder", &po) && po < 100 ? (int)po : CL_UNKNOWN);
    s->state = parse_state(p, get(p, o, "state"));
    get_string(p, o, "needsAttentionReason", s->reason, sizeof(s->reason));
    s->state_age_s = get_age(p, o, "stateSince", now);
    s->last_activity_age_s = get_age(p, o, "lastActivityAt", now);

    int sub = get(p, o, "subagents");
    s->agents_active = (int16_t)get_i64(p, sub, "active");
    s->agents_total = (int16_t)get_i64(p, sub, "knownTotal");
    s->agents_partial = get_bool(p, sub, "partial");
    s->agents_oldest_age_s = get_age(p, sub, "oldestActiveSince", now);
    int types = get(p, sub, "types");
    if (types >= 0 && p->t[types].type == JSMN_ARRAY) {
        int j = types + 1;
        for (int k = 0; k < p->t[types].size; k++) {
            if (s->agent_type_count < CL_MAX_AGENT_TYPES && p->t[j].type == JSMN_STRING)
                copy_json_string(p, j, s->agent_types[s->agent_type_count++], CL_MAX_AGENT_TYPE);
            j = skip(p, j);
        }
    }

    int tok = get(p, o, "tokens");
    s->tokens = get_i64(p, tok, "sessionTotal");
    s->cache_read = get_i64(p, tok, "cacheRead");

    double pct;
    int ctx = get(p, o, "context");
    s->context_pct = (int8_t)(get_number(p, ctx, "usedPercent", &pct) ? (pct < 0 ? 0 : pct > 100 ? 100 : (int)(pct + 0.5))
                                                                        : CL_UNKNOWN);
}

bool cl_model_parse(const char *json, size_t len, cl_snapshot_t *out)
{
    static jsmntok_t *tokens;
    memset(out, 0, sizeof(*out));
    if (!tokens) tokens = (jsmntok_t *)malloc(sizeof(jsmntok_t) * CL_MAX_TOKENS);
    if (!tokens || !json) return false;

    jsmn_parser jp;
    jsmn_init(&jp);
    int n = jsmn_parse(&jp, json, len, tokens, CL_MAX_TOKENS);
    if (n < 1 || tokens[0].type != JSMN_OBJECT) return false;
    parser_t p = {json, tokens, n};

    double ver;
    if (!get_number(&p, 0, "schemaVersion", &ver) || (int)ver != CL_SCHEMA_VERSION) return false;

    int gen = get(&p, 0, "generatedAt");
    int64_t now;
    if (gen < 0 || tokens[gen].type != JSMN_STRING ||
        !cl_parse_iso8601(json + tokens[gen].start, (size_t)(tokens[gen].end - tokens[gen].start), &now))
        return false;

    int host = get(&p, 0, "host");
    get_string(&p, host, "displayName", out->host_name, sizeof(out->host_name));

    int col = get(&p, 0, "collection");
    int st = get(&p, col, "status");
    out->collection = st >= 0 && tok_is(&p, st, "error")      ? CL_COLLECTION_ERROR
                      : st >= 0 && tok_is(&p, st, "degraded") ? CL_COLLECTION_DEGRADED
                                                               : CL_COLLECTION_HEALTHY;
    get_string(&p, col, "message", out->collection_message, sizeof(out->collection_message));
    out->hooks_installed = get_bool(&p, col, "hooksInstalled");

    int sessions = get(&p, 0, "sessions");
    if (sessions < 0 || tokens[sessions].type != JSMN_ARRAY) return false;
    out->total_sessions = (uint16_t)tokens[sessions].size;
    int j = sessions + 1;
    for (int k = 0; k < tokens[sessions].size; k++) {
        if (out->session_count < CL_MAX_SESSIONS && tokens[j].type == JSMN_OBJECT)
            parse_session(&p, j, now, &out->sessions[out->session_count++]);
        j = skip(&p, j);
    }

    int daily = get(&p, 0, "dailyUsage");
    out->daily_tokens = get_i64(&p, daily, "tokens");

    int rl = get(&p, 0, "rateLimits");
    if (!is_null(&p, rl)) {
        parse_rate(&p, rl, "fiveHour", now, &out->five_hour);
        parse_rate(&p, rl, "sevenDay", now, &out->seven_day);
    }

    out->valid = true;
    return true;
}

const char *cl_state_label(cl_state_t s)
{
    switch (s) {
    case CL_STATE_WORKING: return "Working";
    case CL_STATE_NEEDS_ATTENTION: return "Needs you";
    case CL_STATE_READY: return "Ready";
    case CL_STATE_FAILED: return "Error";
    case CL_STATE_STOPPED: return "Stopped";
    default: return "Unknown";
    }
}
