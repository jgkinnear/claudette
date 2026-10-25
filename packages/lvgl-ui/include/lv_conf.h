/**
 * LVGL configuration shared by the firmware and the WebAssembly simulator.
 * Anything not set here falls back to LVGL's defaults (lv_conf_internal.h).
 * Both targets render RGB565 so the simulator shows exactly what the panel shows.
 */
#ifndef LV_CONF_H
#define LV_CONF_H

#define LV_COLOR_FORMAT_DEFAULT LV_COLOR_FORMAT_RGB565

#define LV_USE_STDLIB_MALLOC LV_STDLIB_CLIB
#define LV_USE_STDLIB_STRING LV_STDLIB_CLIB
#define LV_USE_STDLIB_SPRINTF LV_STDLIB_CLIB

#define LV_USE_OS LV_OS_NONE
#define LV_DEF_REFR_PERIOD 33
#define LV_DPI_DEF 130

#define LV_USE_LOG 0
#define LV_USE_SYSMON 0
#define LV_USE_PERF_MONITOR 0

/* Sprites are 4-bit indexed; keep decoded copies around instead of re-decoding every frame. */
#define LV_CACHE_DEF_SIZE (96 * 1024)

#define LV_USE_DRAW_SW 1
#define LV_DRAW_SW_COMPLEX 1

/* Built-in fonts: used for LV_SYMBOL_* icons. Text uses Claudette's own fonts. */
#define LV_FONT_MONTSERRAT_14 1
#define LV_FONT_MONTSERRAT_16 1
#define LV_FONT_MONTSERRAT_20 1
#define LV_FONT_DEFAULT &lv_font_montserrat_14

#define LV_USE_QRCODE 1

#define LV_USE_THEME_DEFAULT 1
#define LV_THEME_DEFAULT_DARK 1

/* Unused widgets, kept out to save flash. */
#define LV_USE_CALENDAR 0
#define LV_USE_CHART 0
#define LV_USE_KEYBOARD 0
#define LV_USE_IMAGEBUTTON 0
#define LV_USE_MENU 0
#define LV_USE_SPINBOX 0
#define LV_USE_TABLE 0
#define LV_USE_WIN 0
#define LV_USE_SCALE 0
#define LV_USE_LED 0
#define LV_USE_LINE 1
#define LV_USE_ROLLER 0
#define LV_USE_DROPDOWN 0
#define LV_USE_TEXTAREA 0
#define LV_USE_LIST 0
#define LV_USE_CHECKBOX 0
#define LV_USE_MSGBOX 0
#define LV_USE_SPAN 0
#define LV_USE_ANIMIMG 0

#endif /* LV_CONF_H */
