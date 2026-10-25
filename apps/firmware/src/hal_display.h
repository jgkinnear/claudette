/**
 * Display + touch + backlight HAL: LovyanGFX underneath, LVGL 9 on top.
 * Call everything from the UI task.
 */
#pragma once

#include <stdbool.h>
#include <stdint.h>

/** Panel, touch, backlight, lv_init(), LVGL display + pointer indev. */
bool hal_display_init(uint8_t brightness_pct);

/** 5..100 % (clamped). */
void hal_set_brightness(uint8_t percent);
/** Bring-up test: colour fills + forced backlight, then reboot. Serial command `lcdtest`. */
void hal_lcd_test(void);

/** Log every touch point to serial (bring-up aid; serial command "touch"). */
void hal_set_touch_log(bool on);
bool hal_touch_log_enabled(void);
