/* Freenove FNK0104S 4.0" (ST7796 + FT6336U via LovyanGFX). The 3.5" board lives in hal_display_qspi.cpp. */
#if !defined(BOARD_FNK0104N)

#include "hal_display.h"

#include <Arduino.h>
#include <esp_heap_caps.h>

#define LGFX_USE_V1
#include <LovyanGFX.hpp>
#include <lvgl.h>

#include "board_config.h"
#include "log.h"

namespace {

/* Known-good LovyanGFX setup for the Freenove FNK0104S (ST7796 + FT6336U). */
class LGFX_Claudette : public lgfx::LGFX_Device {
    lgfx::Panel_ST7796 _panel;
    lgfx::Bus_SPI _bus;
    lgfx::Light_PWM _light;
    lgfx::Touch_FT5x06 _touch;

   public:
    LGFX_Claudette() {
        {
            auto cfg = _bus.config();
            cfg.spi_host = SPI2_HOST;
            cfg.spi_mode = 0;
            cfg.freq_write = LCD_SPI_FREQ_WRITE;
            cfg.freq_read = LCD_SPI_FREQ_READ;
            cfg.spi_3wire = false;
            cfg.use_lock = true;
            cfg.dma_channel = SPI_DMA_CH_AUTO;
            cfg.pin_sclk = LCD_PIN_SCLK;
            cfg.pin_mosi = LCD_PIN_MOSI;
            cfg.pin_miso = LCD_PIN_MISO;
            cfg.pin_dc = LCD_PIN_DC;
            _bus.config(cfg);
            _panel.setBus(&_bus);
        }
        {
            auto cfg = _panel.config();
            cfg.pin_cs = LCD_PIN_CS;
            cfg.pin_rst = LCD_PIN_RST;
            cfg.pin_busy = -1;
            cfg.panel_width = LCD_WIDTH;
            cfg.panel_height = LCD_HEIGHT;
            cfg.memory_width = LCD_WIDTH;
            cfg.memory_height = LCD_HEIGHT;
            cfg.offset_x = 0;
            cfg.offset_y = 0;
            cfg.offset_rotation = 0;
            cfg.dummy_read_pixel = 8;
            cfg.dummy_read_bits = 1;
            cfg.readable = true;
            cfg.invert = LCD_INVERT;
            cfg.rgb_order = LCD_RGB_ORDER;
            cfg.dlen_16bit = false;
            cfg.bus_shared = false;
            _panel.config(cfg);
        }
        {
            auto cfg = _light.config();
            cfg.pin_bl = LCD_PIN_BL;
            cfg.invert = BL_INVERT;
            cfg.freq = BL_PWM_FREQ;
            cfg.pwm_channel = BL_PWM_CHANNEL;
            _light.config(cfg);
            _panel.setLight(&_light);
        }
        {
            auto cfg = _touch.config();
            cfg.x_min = 0;
            cfg.x_max = TOUCH_X_MAX;
            cfg.y_min = 0;
            cfg.y_max = TOUCH_Y_MAX;
            cfg.pin_int = TOUCH_PIN_INT;
            cfg.pin_rst = TOUCH_PIN_RST;
            cfg.bus_shared = false;
            cfg.offset_rotation = TOUCH_ROTATION;
            cfg.i2c_port = TOUCH_I2C_PORT;
            cfg.i2c_addr = TOUCH_I2C_ADDR;
            cfg.pin_sda = TOUCH_PIN_SDA;
            cfg.pin_scl = TOUCH_PIN_SCL;
            cfg.freq = TOUCH_I2C_FREQ;
            _touch.config(cfg);
            _panel.setTouch(&_touch);
        }
        setPanel(&_panel);
    }
};

LGFX_Claudette s_tft;
lv_display_t *s_disp;
lv_indev_t *s_indev;
bool s_single_buffer;
bool s_touch_log;
bool s_touch_ok;

uint32_t tick_cb(void) { return millis(); }

void flush_cb(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map) {
    const uint32_t w = (uint32_t)lv_area_get_width(area);
    const uint32_t h = (uint32_t)lv_area_get_height(area);
#if LCD_SWAP_BYTES
    /* LVGL's RGB565 is little-endian; the ST7796 wants big-endian on the wire. */
    lv_draw_rgb565_swap(px_map, w * h);
#endif
    /* Keep the SPI bus claimed between flushes: nothing else is on it, and the
     * next pushImageDMA waits for the previous transfer before reusing DMA. */
    if (s_tft.getStartCount() == 0) s_tft.startWrite();
    s_tft.pushImageDMA(area->x1, area->y1, (int32_t)w, (int32_t)h, (const lgfx::swap565_t *)px_map);
    /* With one buffer LVGL would draw into it while DMA still reads it. */
    if (s_single_buffer) s_tft.waitDMA();
    lv_display_flush_ready(disp);
}

void touch_cb(lv_indev_t *indev, lv_indev_data_t *data) {
    (void)indev;
    lgfx::touch_point_t tp;
    if (s_touch_ok && s_tft.getTouch(&tp, 1) > 0) {
        int32_t x = tp.x;
        int32_t y = tp.y;
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
        if (x < 0) x = 0;
        if (y < 0) y = 0;
        if (x >= LCD_WIDTH) x = LCD_WIDTH - 1;
        if (y >= LCD_HEIGHT) y = LCD_HEIGHT - 1;
        data->point.x = x;
        data->point.y = y;
        data->state = LV_INDEV_STATE_PRESSED;
        if (s_touch_log) {
            static uint32_t last;
            if (millis() - last > 100) {
                last = millis();
                LOGI("touch", "x=%ld y=%ld (raw %d,%d)", (long)x, (long)y, tp.x, tp.y);
            }
        }
    } else {
        data->state = LV_INDEV_STATE_RELEASED;
    }
}

uint8_t pct_to_pwm(uint8_t pct) {
    if (pct < 5) pct = 5;
    if (pct > 100) pct = 100;
    return (uint8_t)((pct * 255u + 50u) / 100u);
}

}  // namespace

bool hal_display_init(uint8_t brightness_pct) {
    if (!s_tft.init()) {
        LOGI("lcd", "panel init failed");
    }
    s_tft.setRotation(LCD_ROTATION);
    s_tft.fillScreen(0x0000);
    s_tft.setBrightness(pct_to_pwm(brightness_pct));
    s_touch_ok = s_tft.touch() != nullptr;
    LOGI("lcd", "ST7796 %dx%d @%lu MHz, touch %s", s_tft.width(), s_tft.height(),
         (unsigned long)(LCD_SPI_FREQ_WRITE / 1000000), s_touch_ok ? "ok" : "missing");

    lv_init();
    lv_tick_set_cb(tick_cb);

    s_disp = lv_display_create(LCD_WIDTH, LCD_HEIGHT);
    lv_display_set_color_format(s_disp, LV_COLOR_FORMAT_RGB565);

    const size_t buf_bytes = (size_t)LCD_WIDTH * LVGL_BUF_LINES * 2;
    void *buf1 = heap_caps_aligned_alloc(64, buf_bytes, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    void *buf2 = heap_caps_aligned_alloc(64, buf_bytes, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (!buf1) {
        /* Should never happen at boot; fall back to PSRAM (slower, LovyanGFX copies). */
        LOGI("lcd", "no internal DMA RAM for draw buffers, using PSRAM");
        buf1 = heap_caps_aligned_alloc(64, buf_bytes, MALLOC_CAP_SPIRAM);
    }
    if (!buf2) {
        LOGI("lcd", "single draw buffer");
        s_single_buffer = true;
    }
    if (!buf1) {
        LOGI("lcd", "draw buffer alloc failed");
        return false;
    }
    lv_display_set_buffers(s_disp, buf1, buf2, buf_bytes, LV_DISPLAY_RENDER_MODE_PARTIAL);
    lv_display_set_flush_cb(s_disp, flush_cb);

    s_indev = lv_indev_create();
    lv_indev_set_type(s_indev, LV_INDEV_TYPE_POINTER);
    lv_indev_set_read_cb(s_indev, touch_cb);
    lv_indev_set_display(s_indev, s_disp);

    LOGI("lcd", "LVGL %d.%d.%d ready, 2x%u B draw buffers", LVGL_VERSION_MAJOR, LVGL_VERSION_MINOR,
         LVGL_VERSION_PATCH, (unsigned)buf_bytes);
    return true;
}

void hal_set_brightness(uint8_t percent) { s_tft.setBrightness(pct_to_pwm(percent)); }

/* Bring-up check that bypasses LVGL: solid colours at full brightness, then the backlight pin
 * driven high directly. Tells "panel/SPI problem" apart from "backlight problem". Reboots after. */
void hal_lcd_test(void) {
    static const struct { uint16_t c; const char *name; } fills[] = {
        {0xF800, "red"}, {0x07E0, "green"}, {0x001F, "blue"}, {0xFFFF, "white"}};
    s_tft.waitDMA();
    s_tft.setBrightness(255);
    for (const auto &f : fills) {
        LOGI("lcd", "test: %s at full brightness", f.name);
        s_tft.fillScreen(f.c);
        delay(2000);
    }
    LOGI("lcd", "test: backlight pin %d forced HIGH (no PWM)", LCD_PIN_BL);
    pinMode(LCD_PIN_BL, OUTPUT);
    digitalWrite(LCD_PIN_BL, BL_INVERT ? LOW : HIGH);
    s_tft.fillScreen(0xFFFF);
    delay(3000);
    LOGI("lcd", "test: done, rebooting");
    delay(100);
    ESP.restart();
}

void hal_set_touch_log(bool on) { s_touch_log = on; }
bool hal_touch_log_enabled(void) { return s_touch_log; }

#endif /* !BOARD_FNK0104N */
