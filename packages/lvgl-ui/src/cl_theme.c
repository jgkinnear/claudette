#include "cl_theme.h"

#include <stdio.h>

uint32_t cl_state_color(cl_state_t s)
{
    switch (s) {
    case CL_STATE_WORKING: return CL_C_SAGE;
    case CL_STATE_NEEDS_ATTENTION: return CL_C_AMBER;
    case CL_STATE_READY: return CL_C_CREAM_DIM;
    case CL_STATE_FAILED: return CL_C_CORAL;
    case CL_STATE_STOPPED: return CL_C_GREY;
    default: return CL_C_MUTED;
    }
}

void cl_fmt_tokens(char *buf, size_t size, int64_t t)
{
    if (t < 0) snprintf(buf, size, "\xE2\x80\x94");
    else if (t < 1000) snprintf(buf, size, "%d", (int)t);
    else if (t < 100000) snprintf(buf, size, "%.1fk", (double)t / 1e3);
    else if (t < 1000000) snprintf(buf, size, "%dk", (int)(t / 1000));
    else if (t < 10000000) snprintf(buf, size, "%.2fM", (double)t / 1e6);
    else if (t < 1000000000) snprintf(buf, size, "%.1fM", (double)t / 1e6);
    else snprintf(buf, size, "%.2fB", (double)t / 1e9);
}

void cl_fmt_age(char *buf, size_t size, int64_t s)
{
    if (s < 0) snprintf(buf, size, "\xE2\x80\x94");
    else if (s < 5) snprintf(buf, size, "now");
    else if (s < 60) snprintf(buf, size, "%ds", (int)s);
    else if (s < 3600) snprintf(buf, size, "%dm", (int)(s / 60));
    else if (s < 36000) {
        int m = (int)((s % 3600) / 60);
        if (m) snprintf(buf, size, "%dh %dm", (int)(s / 3600), m);
        else snprintf(buf, size, "%dh", (int)(s / 3600));
    }
    else if (s < 86400 * 2) snprintf(buf, size, "%dh", (int)(s / 3600));
    else snprintf(buf, size, "%dd", (int)(s / 86400));
}

lv_obj_t *cl_box(lv_obj_t *parent)
{
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_remove_style_all(o);
    /* Layout-only: let presses fall through to the card or page underneath. */
    lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE | LV_OBJ_FLAG_CLICKABLE);
    lv_obj_set_size(o, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    return o;
}

lv_obj_t *cl_card(lv_obj_t *parent)
{
    lv_obj_t *o = lv_obj_create(parent);
    lv_obj_remove_style_all(o);
    lv_obj_remove_flag(o, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_color(o, CL_HEX(CL_C_PANEL), 0);
    lv_obj_set_style_bg_opa(o, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(o, 14, 0);
    lv_obj_set_style_pad_all(o, 10, 0);
    lv_obj_set_style_border_color(o, CL_HEX(CL_C_LINE), 0);
    lv_obj_set_style_border_width(o, 1, 0);
    lv_obj_set_style_bg_color(o, CL_HEX(CL_C_PANEL_HI), LV_STATE_PRESSED);
    return o;
}

lv_obj_t *cl_label(lv_obj_t *parent, const lv_font_t *font, uint32_t color, const char *text)
{
    lv_obj_t *l = lv_label_create(parent);
    lv_obj_set_style_text_font(l, font, 0);
    lv_obj_set_style_text_color(l, CL_HEX(color), 0);
    lv_label_set_text(l, text ? text : "");
    return l;
}

void cl_label_oneline(lv_obj_t *l)
{
    lv_label_set_long_mode(l, LV_LABEL_LONG_MODE_DOTS);
    lv_obj_set_height(l, lv_font_get_line_height(lv_obj_get_style_text_font(l, 0)));
}

void cl_chip_set(lv_obj_t *chip, uint32_t color, const char *text)
{
    lv_obj_set_style_bg_color(chip, CL_HEX(color), 0);
    lv_obj_t *l = lv_obj_get_child(chip, 0);
    lv_obj_set_style_text_color(l, CL_HEX(color), 0);
    lv_label_set_text(l, text);
}

lv_obj_t *cl_chip(lv_obj_t *parent, uint32_t color, const char *text)
{
    lv_obj_t *c = cl_box(parent);
    lv_obj_set_style_bg_opa(c, LV_OPA_20, 0);
    lv_obj_set_style_radius(c, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_pad_hor(c, 8, 0);
    lv_obj_set_style_pad_ver(c, 2, 0);
    cl_label(c, &cl_font_12, color, text);
    cl_chip_set(c, color, text);
    return c;
}

lv_obj_t *cl_bar(lv_obj_t *parent, int32_t w, uint32_t color)
{
    lv_obj_t *b = lv_bar_create(parent);
    lv_obj_remove_style_all(b);
    lv_obj_set_size(b, w, 8);
    lv_obj_set_style_bg_color(b, CL_HEX(CL_C_LINE), 0);
    lv_obj_set_style_bg_opa(b, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(b, 4, 0);
    lv_obj_set_style_bg_color(b, CL_HEX(color), LV_PART_INDICATOR);
    lv_obj_set_style_bg_opa(b, LV_OPA_COVER, LV_PART_INDICATOR);
    lv_obj_set_style_radius(b, 4, LV_PART_INDICATOR);
    lv_bar_set_range(b, 0, 100);
    return b;
}

lv_obj_t *cl_button(lv_obj_t *parent, const char *text, uint32_t color, lv_event_cb_t cb, void *user)
{
    lv_obj_t *b = lv_button_create(parent);
    lv_obj_remove_style_all(b);
    lv_obj_set_height(b, 44);
    lv_obj_set_style_bg_color(b, CL_HEX(color), 0);
    lv_obj_set_style_bg_opa(b, LV_OPA_20, 0);
    lv_obj_set_style_bg_opa(b, LV_OPA_40, LV_STATE_PRESSED);
    lv_obj_set_style_border_color(b, CL_HEX(color), 0);
    lv_obj_set_style_border_width(b, 1, 0);
    lv_obj_set_style_border_opa(b, LV_OPA_60, 0);
    lv_obj_set_style_radius(b, 22, 0);
    lv_obj_set_style_pad_hor(b, 16, 0);
    lv_obj_t *l = cl_label(b, &cl_font_14, color, text);
    lv_obj_center(l);
    if (cb) lv_obj_add_event_cb(b, cb, LV_EVENT_CLICKED, user);
    return b;
}

lv_obj_t *cl_screen(void)
{
    lv_obj_t *s = lv_obj_create(NULL);
    lv_obj_remove_style_all(s);
    lv_obj_set_size(s, LV_PCT(100), LV_PCT(100));
    lv_obj_set_style_bg_color(s, CL_HEX(CL_C_BG), 0);
    lv_obj_set_style_bg_opa(s, LV_OPA_COVER, 0);
    lv_obj_set_style_text_color(s, CL_HEX(CL_C_CREAM), 0);
    lv_obj_set_style_text_font(s, &cl_font_14, 0);
    lv_obj_remove_flag(s, LV_OBJ_FLAG_SCROLLABLE);
    return s;
}
