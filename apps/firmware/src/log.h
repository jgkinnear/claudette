/**
 * Tiny serial logger. Concise, one line per event.
 * Never pass secrets (Wi-Fi password, device token, pair secret/code) to it.
 */
#pragma once

#include <Arduino.h>

void log_init(void);
void log_printf(const char *tag, const char *fmt, ...) __attribute__((format(printf, 2, 3)));

#define LOGI(tag, ...) log_printf(tag, __VA_ARGS__)
