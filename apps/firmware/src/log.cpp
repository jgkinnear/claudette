#include "log.h"

#include <stdarg.h>

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

static SemaphoreHandle_t s_log_mutex;

void log_init(void) {
    Serial.begin(115200);
#if ARDUINO_USB_CDC_ON_BOOT && ARDUINO_USB_MODE
    /* Running on a plain USB charger there is no host reading the CDC port;
     * don't let log writes stall the UI waiting for one. */
    Serial.setTxTimeoutMs(0);
#endif
    s_log_mutex = xSemaphoreCreateMutex();
}

void log_printf(const char *tag, const char *fmt, ...) {
    char line[192];
    int n = snprintf(line, sizeof(line), "[%7lu] %-5s ", (unsigned long)millis(), tag);
    if (n < 0) return;
    if ((size_t)n >= sizeof(line)) n = sizeof(line) - 1;

    va_list ap;
    va_start(ap, fmt);
    int m = vsnprintf(line + n, sizeof(line) - n, fmt, ap);
    va_end(ap);
    if (m < 0) m = 0;
    size_t len = (size_t)n + (size_t)m;
    if (len > sizeof(line) - 2) len = sizeof(line) - 2;
    line[len++] = '\n';
    line[len] = '\0';

    if (s_log_mutex) xSemaphoreTake(s_log_mutex, portMAX_DELAY);
    Serial.write((const uint8_t *)line, len);
    if (s_log_mutex) xSemaphoreGive(s_log_mutex);
}
