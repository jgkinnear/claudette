/**
 * Freenove FNK0104N 3.5" display: ST77922 panel over QSPI + its I2C touch controller,
 * driven directly with ESP-IDF's spi_master (no LovyanGFX support for this panel).
 * Same interface as hal_display.cpp. The init sequence, QSPI framing, 4-pixel alignment and
 * touch protocol follow Freenove's own driver (Freenove_ESP32_S3_Display, TFT_eSPI/ST77922*).
 */
#if defined(BOARD_FNK0104N)

#include "hal_display.h"

#include <Arduino.h>
#include <Wire.h>
#include <driver/spi_master.h>
#include <esp_heap_caps.h>
#include <lvgl.h>
#include <string.h>

#include "board_config.h"
#include "cl_ui.h"
#include "log.h"

namespace {

/* Init commands as {cmd, n, delay_ms, n data bytes...}. */
const uint8_t kInit[] = {
    0xF1, 1, 0, 0x00,
    0x60, 3, 0, 0x00, 0x00, 0x00,
    0x65, 1, 0, 0x80,
    0x79, 1, 0, 0x06,
    0x7B, 3, 0, 0x00, 0x08, 0x08,
    0x80, 11, 0, 0x55, 0x62, 0x2F, 0x17, 0xF0, 0x52, 0x70, 0xD2, 0x52, 0x62, 0xEA,
    0x81, 4, 0, 0x26, 0x52, 0x72, 0x27,
    0x84, 2, 0, 0x92, 0x25,
    0x87, 6, 0, 0x10, 0x10, 0x58, 0x00, 0x02, 0x3A,
    0x88, 15, 0, 0x00, 0x00, 0x2C, 0x10, 0x04, 0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x06,
    0x89, 3, 0, 0x00, 0x00, 0x00,
    0x8A, 11, 0, 0x13, 0x00, 0x2C, 0x00, 0x00, 0x2C, 0x10, 0x10, 0x00, 0x3E, 0x19,
    0x8B, 9, 0, 0x15, 0xB1, 0xB1, 0x44, 0x96, 0x2C, 0x10, 0x97, 0x8E,
    0x8C, 13, 0, 0x1D, 0xB1, 0xB1, 0x44, 0x96, 0x2C, 0x10, 0x50, 0x0F, 0x01, 0xC5, 0x12, 0x09,
    0x8D, 1, 0, 0x0C,
    0x8E, 6, 0, 0x33, 0x01, 0x0C, 0x13, 0x01, 0x01,
    0xB3, 2, 0, 0x00, 0x30,
    0xF1, 1, 0, 0x00,
    0x71, 1, 0, 0xD0,
    0x66, 2, 0, 0x02, 0x3F,
    0xBE, 3, 0, 0x26, 0x00, 0x9D,
    0x70, 12, 0, 0x01, 0xA0, 0x11, 0x40, 0xE0, 0x00, 0x11, 0x69, 0x11, 0x00, 0x00, 0x1A,
    0x90, 9, 0, 0x04, 0x04, 0x55, 0x74, 0x00, 0x40, 0x43, 0x27, 0x27,
    0x91, 9, 0, 0x04, 0x04, 0x55, 0x75, 0x00, 0x40, 0x42, 0x27, 0x27,
    0x92, 10, 0, 0x04, 0x44, 0x55, 0xC0, 0x06, 0x00, 0x07, 0x05, 0x90, 0x27,
    0x93, 10, 0, 0x04, 0x43, 0x11, 0x00, 0x00, 0x00, 0x00, 0x05, 0x90, 0x27,
    0x94, 6, 0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x95, 5, 0, 0x96, 0x16, 0x00, 0x00, 0xFF,
    0x96, 12, 0, 0x44, 0x53, 0x03, 0x12, 0x23, 0x24, 0x06, 0x05, 0x94, 0x27, 0x00, 0x44,
    0x97, 12, 0, 0x44, 0x53, 0x47, 0x56, 0x20, 0x20, 0x02, 0x01, 0x94, 0x27, 0x00, 0x44,
    0xBA, 5, 0, 0x55, 0x94, 0x2D, 0x94, 0x27,
    0x9A, 7, 0, 0x40, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00,
    0x9B, 7, 0, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00,
    0x9C, 13, 0, 0x5C, 0x12, 0x00, 0x00, 0x10, 0x12, 0x00, 0x00, 0x10, 0x02, 0x00, 0x00, 0x00,
    0x9D, 8, 0, 0x8A, 0x51, 0x00, 0x00, 0x00, 0x80, 0x1E, 0x01,
    0x9E, 7, 0, 0x51, 0x00, 0x00, 0x00, 0x80, 0x1E, 0x01,
    0xB4, 12, 0, 0x1D, 0x1C, 0x1E, 0x0B, 0x14, 0x02, 0x13, 0x09, 0x1E, 0x00, 0x1E, 0x10,
    0xB5, 12, 0, 0x1D, 0x1C, 0x1E, 0x0A, 0x15, 0x03, 0x11, 0x08, 0x1E, 0x01, 0x1E, 0x12,
    0xB6, 7, 0, 0x77, 0x77, 0x00, 0x0A, 0xFF, 0x0A, 0xFF,
    0x86, 14, 0, 0xCD, 0x04, 0xB1, 0x02, 0x58, 0x12, 0x58, 0x0C, 0x13, 0x01, 0xA5, 0x00, 0xA5, 0xA5,
    0xB7, 16, 0, 0x07, 0x0A, 0x0E, 0x06, 0x05, 0x03, 0x2B, 0x03, 0x03, 0x42, 0x07, 0x10, 0x10, 0x2E, 0x3F, 0x0D,
    0xB8, 16, 0, 0x07, 0x0A, 0x0D, 0x05, 0x05, 0x02, 0x2B, 0x02, 0x03, 0x42, 0x06, 0x10, 0x0F, 0x2E, 0x3F, 0x0D,
    0xB9, 2, 0, 0x23, 0x23,
    0xBF, 6, 0, 0x10, 0x14, 0x14, 0x0B, 0x0B, 0x0B,
    0xF2, 1, 0, 0x00,
    0x73, 5, 0, 0x04, 0xDA, 0x12, 0x54, 0x47,
    0x77, 5, 0, 0x6B, 0x5B, 0xFD, 0xC3, 0xC5,
    0x7A, 2, 0, 0x15, 0x27,
    0x7B, 2, 0, 0x04, 0x57,
    0x7E, 2, 0, 0x01, 0x0E,
    0xBF, 1, 0, 0x36,
    0xE3, 2, 0, 0x40, 0x40,
    0xF0, 1, 0, 0x00,
    0xD0, 1, 0, 0x00,
    0x2A, 4, 0, 0x00, 0x00, 0x01, 0x3F,
    0x2B, 4, 0, 0x00, 0x00, 0x01, 0xDF,
    0x21, 0, 0,
    0x11, 0, 120,
    0x29, 0, 0,
    0x2C, 0, 0,
    0x3A, 1, 0, 0x01,
    0x36, 1, 0, 0x00,
    0x35, 1, 20, 0x01,
};

constexpr uint8_t QSPI_CMD_1LINE = 0x02; /* register write: cmd, addr and data on one line */
constexpr uint8_t QSPI_CMD_4LINE = 0x32; /* pixel write: data on four lines */
constexpr uint8_t RAMWR_CONT = 0x3C;     /* what Freenove's driver uses after setting the window */
constexpr uint8_t TOUCH_REG_STATUS = 0x01;
constexpr uint8_t TOUCH_REG_MAX_TOUCHES = 0x09;
constexpr uint16_t TOUCH_REG_INFO = 0x0010;
constexpr uint16_t TOUCH_REG_POINT0 = 0x0014;

spi_device_handle_t s_qspi;
lv_display_t *s_disp;
lv_indev_t *s_indev;
bool s_touch_ok;
bool s_touch_log;
uint8_t s_touch_points = 1;
uint8_t *s_rot_buf; /* rotated copy of one draw buffer (landscape / flipped), internal DMA RAM */

uint32_t tick_cb(void) { return millis(); }

void write_reg(uint8_t cmd, const uint8_t *data, size_t len) {
    spi_transaction_ext_t t;
    memset(&t, 0, sizeof(t));
    t.base.flags = SPI_TRANS_VARIABLE_CMD | SPI_TRANS_VARIABLE_ADDR;
    t.base.cmd = QSPI_CMD_1LINE;
    t.base.addr = (uint32_t)cmd << 8;
    t.command_bits = 8;
    t.address_bits = 24;
    t.base.tx_buffer = len ? data : nullptr;
    t.base.length = len * 8;
    spi_device_polling_transmit(s_qspi, &t.base);
}

void set_window(uint16_t x1, uint16_t y1, uint16_t x2, uint16_t y2) {
    const uint8_t x[] = {(uint8_t)(x1 >> 8), (uint8_t)x1, (uint8_t)(x2 >> 8), (uint8_t)x2};
    const uint8_t y[] = {(uint8_t)(y1 >> 8), (uint8_t)y1, (uint8_t)(y2 >> 8), (uint8_t)y2};
    write_reg(0x2A, x, 4);
    write_reg(0x2B, y, 4);
}

/* Pixels are big-endian RGB565 by the time they get here. One transaction per call. */
void write_pixels(const void *px, uint32_t count) {
    spi_transaction_ext_t t;
    memset(&t, 0, sizeof(t));
    t.base.flags = SPI_TRANS_MODE_QIO | SPI_TRANS_VARIABLE_CMD | SPI_TRANS_VARIABLE_ADDR;
    t.base.cmd = QSPI_CMD_4LINE;
    t.base.addr = (uint32_t)RAMWR_CONT << 8;
    t.command_bits = 8;
    t.address_bits = 24;
    t.base.tx_buffer = px;
    t.base.length = count * 16;
    spi_device_polling_transmit(s_qspi, &t.base);
}

void panel_init(void) {
    for (size_t i = 0; i < sizeof(kInit);) {
        const uint8_t cmd = kInit[i], n = kInit[i + 1], wait = kInit[i + 2];
        write_reg(cmd, n ? &kInit[i + 3] : nullptr, n);
        if (wait) delay(wait);
        i += 3 + n;
    }
}

/* The ST77922 wants windows aligned to 4 pixels. */
void rounder_cb(lv_event_t *e) {
    lv_area_t *a = (lv_area_t *)lv_event_get_param(e);
    a->x1 &= ~3;
    a->y1 &= ~3;
    a->x2 |= 3;
    a->y2 |= 3;
}

void flush_cb(lv_display_t *disp, const lv_area_t *logical, uint8_t *px_map) {
    lv_area_t panel;
    px_map = cl_ui_rotate_flush(disp, logical, px_map, s_rot_buf, &panel);
    const lv_area_t *area = &panel;
    const uint32_t w = (uint32_t)lv_area_get_width(area);
    const uint32_t h = (uint32_t)lv_area_get_height(area);
    lv_draw_rgb565_swap(px_map, w * h);
    set_window(area->x1, area->y1, area->x2, area->y2);
    write_pixels(px_map, w * h);
    lv_display_flush_ready(disp);
}

/* ---- touch (16-bit register addresses) ---------------------------------- */

bool touch_read(uint16_t reg, uint8_t *buf, size_t len) {
    Wire.beginTransmission(TOUCH_I2C_ADDR);
    Wire.write((uint8_t)(reg >> 8));
    Wire.write((uint8_t)reg);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom((uint16_t)TOUCH_I2C_ADDR, (size_t)len) != len) return false;
    for (size_t i = 0; i < len; i++) buf[i] = Wire.read();
    return true;
}

bool touch_init(void) {
    Wire.begin(TOUCH_PIN_SDA, TOUCH_PIN_SCL);
    Wire.setClock(TOUCH_I2C_FREQ);
    pinMode(TOUCH_PIN_INT, INPUT);
    pinMode(TOUCH_PIN_RST, OUTPUT);
    digitalWrite(TOUCH_PIN_RST, LOW);
    delay(100);
    digitalWrite(TOUCH_PIN_RST, HIGH);
    delay(100);
    uint8_t v = 0xFF;
    for (int tries = 0; tries < 100; tries++) {
        if (touch_read(TOUCH_REG_STATUS, &v, 1) && (v & 0x0F) == 0) break;
        delay(1);
    }
    if (!touch_read(TOUCH_REG_MAX_TOUCHES, &v, 1)) return false;
    s_touch_points = v < 1 ? 1 : v > 10 ? 10 : v;
    return true;
}

void touch_cb(lv_indev_t *indev, lv_indev_data_t *data) {
    (void)indev;
    data->state = LV_INDEV_STATE_RELEASED;
    if (!s_touch_ok) return;
    uint8_t info = 0;
    if (!touch_read(TOUCH_REG_INFO, &info, 1) || !(info & 0x08)) return;
    uint8_t p[7 * 10];
    if (!touch_read(TOUCH_REG_POINT0, p, 7 * s_touch_points) || !(p[0] & 0x80)) return;
    int32_t x = ((p[0] & 0x3F) << 8) | p[1];
    int32_t y = ((p[2] & 0x3F) << 8) | p[3];
#if TOUCH_SWAP_XY
    int32_t t = x;
    x = y;
    y = t;
#endif
#if TOUCH_INVERT_X
    x = (LCD_WIDTH - 1) - x;
#endif
#if TOUCH_INVERT_Y
    y = (LCD_HEIGHT - 1) - y;
#endif
    if (x < 0 || y < 0 || x >= LCD_WIDTH || y >= LCD_HEIGHT) return;
    data->point.x = x;
    data->point.y = y;
    data->state = LV_INDEV_STATE_PRESSED;
    if (s_touch_log) {
        static uint32_t last;
        if (millis() - last > 100) {
            last = millis();
            LOGI("touch", "x=%ld y=%ld", (long)x, (long)y);
        }
    }
}

/* ---- backlight ---------------------------------------------------------- */

void backlight(uint8_t pct) {
    if (pct < 5) pct = 5;
    if (pct > 100) pct = 100;
    uint32_t duty = (pct * 255u + 50u) / 100u;
    ledcWrite(BL_PWM_CHANNEL, BL_INVERT ? 255 - duty : duty);
}

bool qspi_init(void) {
    pinMode(LCD_PIN_BL, OUTPUT);
    digitalWrite(LCD_PIN_BL, BL_INVERT ? HIGH : LOW); /* dark until the panel is ready */

    spi_bus_config_t bus;
    memset(&bus, 0, sizeof(bus));
    bus.mosi_io_num = LCD_QSPI_D0;
    bus.miso_io_num = LCD_QSPI_D1;
    bus.quadwp_io_num = LCD_QSPI_D2;
    bus.quadhd_io_num = LCD_QSPI_D3;
    bus.sclk_io_num = LCD_QSPI_SCLK;
    bus.max_transfer_sz = LCD_WIDTH * LVGL_BUF_LINES * 2 + 64;
    bus.flags = SPICOMMON_BUSFLAG_MASTER | SPICOMMON_BUSFLAG_IOMUX_PINS | SPICOMMON_BUSFLAG_QUAD;
    if (spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO) != ESP_OK) return false;

    spi_device_interface_config_t dev;
    memset(&dev, 0, sizeof(dev));
    dev.mode = 0;
    dev.clock_speed_hz = LCD_QSPI_FREQ;
    dev.spics_io_num = LCD_PIN_CS;
    dev.flags = SPI_DEVICE_HALFDUPLEX;
    dev.queue_size = 4;
    return spi_bus_add_device(SPI2_HOST, &dev, &s_qspi) == ESP_OK;
}

/* Fill the whole screen with one colour using a small strip buffer. */
void fill_screen(uint16_t rgb565) {
    static uint16_t *strip;
    const uint32_t lines = 16;
    if (!strip) strip = (uint16_t *)heap_caps_malloc(LCD_WIDTH * lines * 2, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (!strip) return;
    const uint16_t be = (uint16_t)((rgb565 >> 8) | (rgb565 << 8));
    for (uint32_t i = 0; i < LCD_WIDTH * lines; i++) strip[i] = be;
    for (uint32_t y = 0; y < LCD_HEIGHT; y += lines) {
        set_window(0, y, LCD_WIDTH - 1, y + lines - 1);
        write_pixels(strip, LCD_WIDTH * lines);
    }
}

}  // namespace

bool hal_display_init(uint8_t brightness_pct) {
    if (!qspi_init()) {
        LOGI("lcd", "QSPI bus init failed");
        return false;
    }
    panel_init();
    fill_screen(0x0000);
    ledcSetup(BL_PWM_CHANNEL, BL_PWM_FREQ, 8);
    ledcAttachPin(LCD_PIN_BL, BL_PWM_CHANNEL);
    backlight(brightness_pct);
    s_touch_ok = touch_init();
    LOGI("lcd", "ST77922 %dx%d QSPI @%lu MHz, touch %s (%u points)", LCD_WIDTH, LCD_HEIGHT,
         (unsigned long)(LCD_QSPI_FREQ / 1000000), s_touch_ok ? "ok" : "not responding", s_touch_points);

    lv_init();
    lv_tick_set_cb(tick_cb);
    s_disp = lv_display_create(LCD_WIDTH, LCD_HEIGHT);
    lv_display_set_color_format(s_disp, LV_COLOR_FORMAT_RGB565);
    const size_t buf_bytes = (size_t)LCD_WIDTH * LVGL_BUF_LINES * 2;
    void *buf1 = heap_caps_aligned_alloc(64, buf_bytes, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    void *buf2 = heap_caps_aligned_alloc(64, buf_bytes, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (!buf1) {
        LOGI("lcd", "draw buffer alloc failed");
        return false;
    }
    s_rot_buf = (uint8_t *)heap_caps_aligned_alloc(64, buf_bytes, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (!s_rot_buf) LOGI("lcd", "no rotation buffer: portrait only");
    lv_display_set_buffers(s_disp, buf1, buf2, buf_bytes, LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_flush_cb(s_disp, flush_cb);
    lv_display_add_event_cb(s_disp, rounder_cb, LV_EVENT_INVALIDATE_AREA, nullptr);

    s_indev = lv_indev_create();
    lv_indev_set_type(s_indev, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(s_indev, touch_cb);
    lv_indev_set_display(s_indev, s_disp);
    LOGI("lcd", "LVGL %d.%d.%d ready, %s %u B draw buffers", LVGL_VERSION_MAJOR, LVGL_VERSION_MINOR,
         LVGL_VERSION_PATCH, buf2 ? "2x" : "1x", (unsigned)buf_bytes);
    return true;
}

void hal_set_brightness(uint8_t percent) { backlight(percent); }

void hal_lcd_test(void) {
    static const struct { uint16_t c; const char *name; } fills[] = {
        {0xF800, "red"}, {0x07E0, "green"}, {0x001F, "blue"}, {0xFFFF, "white"}};
    backlight(100);
    for (const auto &f : fills) {
        LOGI("lcd", "test: %s at full brightness", f.name);
        fill_screen(f.c);
        delay(2000);
    }
    LOGI("lcd", "test: done, rebooting");
    delay(100);
    ESP.restart();
}

void hal_set_touch_log(bool on) { s_touch_log = on; }
bool hal_touch_log_enabled(void) { return s_touch_log; }

#endif /* BOARD_FNK0104N */
