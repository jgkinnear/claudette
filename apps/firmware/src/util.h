#pragma once

#include <Arduino.h>
#include <stddef.h>
#include <stdint.h>

/** Copy at most size-1 bytes of UTF-8, never splitting a code point. */
void util_copy_utf8(char *dst, size_t size, const char *src);

/** Append HTML-escaped text (safe in element bodies and quoted attributes). */
void util_html_escape(String &out, const char *s);

/** Lowercase hex of `len` random bytes from the hardware RNG into out (2*len+1). */
void util_random_hex(char *out, size_t len);

/** Friendly random Wi-Fi password like "tavo-mizu-kepa" (14 chars). */
void util_friendly_password(char *out, size_t size);

/** Overwrite a buffer so secrets don't linger in RAM. */
void util_wipe(void *p, size_t n);

/** Uniform random int in [lo, hi]. */
int32_t util_rand_range(int32_t lo, int32_t hi);
