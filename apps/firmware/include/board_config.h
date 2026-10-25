/**
 * Board configuration: Freenove FNK0104S (4.0" ESP32-S3 display, N16R8).
 *
 * Every value is #ifndef-guarded so another board can override it from
 * platformio.ini (`build_flags = -DLCD_PIN_DC=7 ...`) without editing this file.
 */
#pragma once

/* ---- Board variants ---------------------------------------------------------
 * Default: Freenove FNK0104S 4.0" (ST7796 over SPI, FT6336U touch).
 * -DBOARD_FNK0104N: Freenove FNK0104N 3.5" (ST77922 over QSPI, touch controller at 0x55).
 * Pins for the 3.5" come from Freenove's own driver (Freenove_ESP32_S3_Display). */
#if defined(BOARD_FNK0104N)
#define CLAUDETTE_BOARD_NAME "freenove-s3-35in"
#define LCD_PIN_CS 10
#define LCD_PIN_BL 41
#define LCD_QSPI_SCLK 12
#define LCD_QSPI_D0 11
#define LCD_QSPI_D1 13
#define LCD_QSPI_D2 14
#define LCD_QSPI_D3 9
#ifndef LCD_QSPI_FREQ
#define LCD_QSPI_FREQ 80000000
#endif
#define TOUCH_PIN_SDA 38
#define TOUCH_PIN_SCL 39
#define TOUCH_PIN_INT 47
#define TOUCH_PIN_RST 48
#define TOUCH_I2C_ADDR 0x55
#define TOUCH_I2C_FREQ 100000
#endif

#ifndef CLAUDETTE_FW_VERSION
#define CLAUDETTE_FW_VERSION "0.1.0"
#endif

#ifndef CLAUDETTE_BOARD_NAME
#define CLAUDETTE_BOARD_NAME "freenove-s3-4in"
#endif

/* ---- LCD: ST7796, 320x480, 4-wire SPI ---------------------------------- */
#ifndef LCD_PIN_SCLK
#define LCD_PIN_SCLK 12
#endif
#ifndef LCD_PIN_MOSI
#define LCD_PIN_MOSI 11
#endif
#ifndef LCD_PIN_MISO
#define LCD_PIN_MISO 13
#endif
#ifndef LCD_PIN_CS
#define LCD_PIN_CS 10
#endif
#ifndef LCD_PIN_DC
#define LCD_PIN_DC 46
#endif
#ifndef LCD_PIN_RST
#define LCD_PIN_RST -1
#endif
#ifndef LCD_PIN_BL
#define LCD_PIN_BL 45
#endif

/* SPI write clock. 40 MHz is safe; the panel is usually fine at 80 MHz. */
#ifndef LCD_SPI_FREQ_WRITE
#define LCD_SPI_FREQ_WRITE 40000000
#endif
#ifndef LCD_SPI_FREQ_READ
#define LCD_SPI_FREQ_READ 16000000
#endif

#ifndef LCD_WIDTH
#define LCD_WIDTH 320
#endif
#ifndef LCD_HEIGHT
#define LCD_HEIGHT 480
#endif

/* Colours look like a photo negative?  Flip LCD_INVERT.
 * Red and blue swapped?                 Flip LCD_RGB_ORDER. */
#ifndef LCD_INVERT
#define LCD_INVERT true
#endif
#ifndef LCD_RGB_ORDER
#define LCD_RGB_ORDER true
#endif

/* LovyanGFX rotation 0..3. The UI is portrait 320x480, so keep 0 or 2. */
#ifndef LCD_ROTATION
#define LCD_ROTATION 0
#endif

/* LVGL renders little-endian RGB565; SPI panels want big-endian. Set to 0 only
 * if the colours look like noise/speckled (bytes already swapped somewhere). */
#ifndef LCD_SWAP_BYTES
#define LCD_SWAP_BYTES 1
#endif

/* Backlight: PWM, active high. */
#ifndef BL_PWM_FREQ
#define BL_PWM_FREQ 12000
#endif
#ifndef BL_PWM_CHANNEL
#define BL_PWM_CHANNEL 7
#endif
#ifndef BL_INVERT
#define BL_INVERT false
#endif

/* ---- Touch: FT6336U (FT5x06 family), I2C ---------------------------------- */
#ifndef TOUCH_I2C_PORT
#define TOUCH_I2C_PORT 0
#endif
#ifndef TOUCH_PIN_SDA
#define TOUCH_PIN_SDA 16
#endif
#ifndef TOUCH_PIN_SCL
#define TOUCH_PIN_SCL 15
#endif
#ifndef TOUCH_PIN_INT
#define TOUCH_PIN_INT 17
#endif
#ifndef TOUCH_PIN_RST
#define TOUCH_PIN_RST 18
#endif
#ifndef TOUCH_I2C_ADDR
#define TOUCH_I2C_ADDR 0x38
#endif
#ifndef TOUCH_I2C_FREQ
#define TOUCH_I2C_FREQ 400000
#endif
#ifndef TOUCH_X_MAX
#define TOUCH_X_MAX 319
#endif
#ifndef TOUCH_Y_MAX
#define TOUCH_Y_MAX 479
#endif
/* LovyanGFX touch offset_rotation (0..7) relative to the panel. */
#ifndef TOUCH_ROTATION
#define TOUCH_ROTATION 0
#endif
/* Extra fix-ups applied after LovyanGFX's mapping, in screen coordinates.
 * Taps land mirrored left/right -> TOUCH_INVERT_X 1; up/down -> TOUCH_INVERT_Y 1;
 * moving your finger right moves the cursor down -> TOUCH_SWAP_XY 1. */
#ifndef TOUCH_SWAP_XY
#define TOUCH_SWAP_XY 0
#endif
#ifndef TOUCH_INVERT_X
#define TOUCH_INVERT_X 0
#endif
#ifndef TOUCH_INVERT_Y
#define TOUCH_INVERT_Y 0
#endif

/* ---- Buttons ------------------------------------------------------------ */
/* BOOT button (GPIO0, active low). Hold 3 s: open the setup portal.
 * Hold 10 s: factory reset. Set to -1 to disable. */
#ifndef BOOT_BUTTON_PIN
#define BOOT_BUTTON_PIN 0
#endif

/* ---- LVGL --------------------------------------------------------------- */
/* Lines per partial render buffer (two buffers, internal DMA RAM).
 * 48 lines = 1/10 of the screen = 30 KB each. */
#ifndef LVGL_BUF_LINES
#define LVGL_BUF_LINES 48
#endif

/* ---- Networking --------------------------------------------------------- */
#ifndef CLAUDETTE_DEFAULT_PORT
#define CLAUDETTE_DEFAULT_PORT 3333
#endif
#ifndef CLAUDETTE_MAX_BODY
#define CLAUDETTE_MAX_BODY (48 * 1024)
#endif
#ifndef CLAUDETTE_POLL_MS
#define CLAUDETTE_POLL_MS 3000
#endif
#ifndef CLAUDETTE_OFFLINE_AFTER_MS
#define CLAUDETTE_OFFLINE_AFTER_MS 15000
#endif
