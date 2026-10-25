/**
 * Minimal, bounded HTTP/1.0 client for the Claudette device API. Network task only.
 *
 * Returns the HTTP status (>0) or a negative error. The response body is
 * NUL-terminated in `buf`; bodies larger than cap-1 bytes are rejected.
 * The bearer token is sent only in the Authorization header and never logged.
 */
#pragma once

#include <IPAddress.h>
#include <stddef.h>
#include <stdint.h>

#define HTTP_ERR_BEGIN (-100)
#define HTTP_ERR_TOO_LARGE (-101)
#define HTTP_ERR_TRUNCATED (-102)

int http_call(const IPAddress &ip, uint16_t port, const char *method, const char *path,
              const char *json_body, const char *bearer, char *buf, size_t cap, size_t *out_len);

/** Short text for a negative error code (for logs / screens). */
const char *http_err_str(int code);
