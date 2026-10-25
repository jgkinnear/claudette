/** Claudette's look: colours, fonts and small formatting helpers. */
#ifndef CL_THEME_H
#define CL_THEME_H

#include "cl_model.h"
#include "lvgl.h"

#define CL_HEX(h) lv_color_hex(h)

/* "Tiny cosy command centre": warm cream on deep navy. */
#define CL_C_BG 0x141B29
#define CL_C_PANEL 0x1F2A3E
#define CL_C_PANEL_HI 0x27354D
#define CL_C_LINE 0x33415C
#define CL_C_CREAM 0xF5EBDD
#define CL_C_CREAM_DIM 0xBDB2A3
#define CL_C_MUTED 0x8A93A6
#define CL_C_TERRACOTTA 0xD97757
#define CL_C_SAGE 0x8FB996
#define CL_C_AMBER 0xE8B04A
#define CL_C_CORAL 0xE07A6A
#define CL_C_GREY 0x7D8699
#define CL_C_ROSE 0xF28FAD

LV_FONT_DECLARE(cl_font_12)
LV_FONT_DECLARE(cl_font_14)
LV_FONT_DECLARE(cl_font_16)
LV_FONT_DECLARE(cl_font_20)
LV_FONT_DECLARE(cl_font_28)
LV_FONT_DECLARE(cl_font_44)

uint32_t cl_state_color(cl_state_t s);

/** "84.2k", "1.24M". Unknown → "—". */
void cl_fmt_tokens(char *buf, size_t size, int64_t tokens);
/** Compact age: "now", "42s", "5m", "2h 5m", "3d". */
void cl_fmt_age(char *buf, size_t size, int64_t seconds);

/* Small widget helpers used across screens. */
lv_obj_t *cl_box(lv_obj_t *parent);               /* transparent, no padding, no scroll, not clickable */
lv_obj_t *cl_card(lv_obj_t *parent);              /* rounded panel */
lv_obj_t *cl_label(lv_obj_t *parent, const lv_font_t *font, uint32_t color, const char *text);
/** Single line with "…" when too long (label needs a width or flex grow). */
void cl_label_oneline(lv_obj_t *label);
lv_obj_t *cl_chip(lv_obj_t *parent, uint32_t color, const char *text);
void cl_chip_set(lv_obj_t *chip, uint32_t color, const char *text);
lv_obj_t *cl_bar(lv_obj_t *parent, int32_t w, uint32_t color);
lv_obj_t *cl_button(lv_obj_t *parent, const char *text, uint32_t color, lv_event_cb_t cb, void *user);
lv_obj_t *cl_screen(void);

#endif /* CL_THEME_H */
