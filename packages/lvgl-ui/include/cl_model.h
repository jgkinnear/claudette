/**
 * Claudette presentation model — bounded C mirror of packages/protocol (schema v1).
 *
 * The firmware and the browser simulator both turn the service's JSON snapshot
 * into this struct with cl_model_parse(), then hand it to the UI. Everything is
 * fixed-size: no heap, no unbounded strings.
 */
#ifndef CL_MODEL_H
#define CL_MODEL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define CL_SCHEMA_VERSION 1
#define CL_MAX_SESSIONS 12
#define CL_MAX_NAME 41      /* 40 bytes + NUL; UTF-8 safe truncation */
#define CL_MAX_ID 33
#define CL_MAX_REASON 41
#define CL_MAX_AGENT_TYPES 4
#define CL_MAX_AGENT_TYPE 25
#define CL_MAX_HOST 41
#define CL_MAX_MESSAGE 81

/** "Unknown" sentinel for integer metrics. Unavailable is never zero. */
#define CL_UNKNOWN (-1)

typedef enum {
    CL_STATE_UNKNOWN = 0,
    CL_STATE_WORKING,
    CL_STATE_NEEDS_ATTENTION,
    CL_STATE_READY,
    CL_STATE_FAILED,
    CL_STATE_STOPPED,
} cl_state_t;

typedef enum {
    CL_QUALITY_UNAVAILABLE = 0,
    CL_QUALITY_OBSERVED,
    CL_QUALITY_ESTIMATED,
} cl_quality_t;

typedef enum {
    CL_COLLECTION_HEALTHY = 0,
    CL_COLLECTION_DEGRADED,
    CL_COLLECTION_ERROR,
} cl_collection_t;

/* All times are converted to seconds relative to the snapshot's generatedAt:
 * age_s = generatedAt - timestamp (>= 0), or CL_UNKNOWN when absent. This keeps
 * the device independent of wall-clock time (no SNTP/internet needed). */
typedef struct {
    char id[CL_MAX_ID];
    char name[CL_MAX_NAME];
    bool background;
    bool pinned;
    int8_t pin_order;               /* CL_UNKNOWN when not pinned */
    cl_state_t state;
    char reason[CL_MAX_REASON];     /* needs-attention reason, "" if none */
    int32_t state_age_s;

    int16_t agents_active;          /* CL_UNKNOWN when unavailable */
    int16_t agents_total;
    uint8_t agent_type_count;
    char agent_types[CL_MAX_AGENT_TYPES][CL_MAX_AGENT_TYPE];
    int32_t agents_oldest_age_s;
    bool agents_partial;

    int64_t tokens;                 /* input + output + cache writes, CL_UNKNOWN if unavailable */
    int64_t cache_read;
    int8_t context_pct;             /* 0..100 or CL_UNKNOWN (needs the Claudette status line) */
    int64_t context_tokens;         /* tokens in the context window now, CL_UNKNOWN if unavailable */

    int32_t last_activity_age_s;
} cl_session_t;

typedef struct {
    bool present;
    int8_t used_pct;
    int32_t resets_in_s;            /* CL_UNKNOWN if not given */
} cl_rate_window_t;

typedef struct {
    bool valid;
    char host_name[CL_MAX_HOST];
    cl_collection_t collection;
    char collection_message[CL_MAX_MESSAGE];
    bool hooks_installed;

    uint8_t session_count;
    cl_session_t sessions[CL_MAX_SESSIONS];
    uint16_t total_sessions;        /* how many the host knows about (may exceed CL_MAX_SESSIONS) */

    int64_t daily_tokens;           /* CL_UNKNOWN if unavailable */
    cl_rate_window_t five_hour;
    cl_rate_window_t seven_day;
} cl_snapshot_t;

/**
 * Parse a protocol v1 snapshot JSON document into `out`.
 * Returns true on success. On failure `out->valid` is false and `out` is
 * otherwise unspecified, so parse into a scratch buffer and swap on success.
 */
bool cl_model_parse(const char *json, size_t len, cl_snapshot_t *out);

/** Parse an ISO-8601 UTC/offset timestamp to Unix seconds. Returns false if malformed. */
bool cl_parse_iso8601(const char *s, size_t len, int64_t *out_epoch_s);

/** Copy UTF-8 text into dst (size bytes), truncating on a code-point boundary with "…" if needed. */
void cl_copy_utf8(char *dst, size_t size, const char *src, size_t src_len);

const char *cl_state_label(cl_state_t s);

#ifdef __cplusplus
}
#endif

#endif /* CL_MODEL_H */
