/**
 * Claudette's screens: dashboard (Home / Agents / Usage), session detail,
 * settings and onboarding. See cl_ui.h for the contract.
 */
#include "cl_ui.h"

#include <stdio.h>
#include <string.h>

#include "cl_mascot.h"
#include "cl_sprites.h"
#include "cl_theme.h"

#define PAGE_PAD 8
#define STRIP_H 28
#define MAX_FEATURED 6
#define MAX_TOP_TOKENS 5

/* ------------------------------------------------------------------ geometry
 * Portrait (320x480): header, pages, usage strip, bottom nav bar.
 * Landscape (480x320): header, left nav rail, pages, usage strip. Recomputed on rotation. */

static int32_t SW = CL_SCREEN_W, SH = CL_SCREEN_H;
static bool LAND;
static int32_t HEADER_H, NAV_H, RAIL_W, PAGE_W, PAGE_H, CARD_W, TILE_W;

static void compute_geometry(void)
{
    lv_display_t *disp = lv_display_get_default();
    SW = lv_display_get_horizontal_resolution(disp);
    SH = lv_display_get_vertical_resolution(disp);
    LAND = SW > SH;
    HEADER_H = LAND ? 44 : 52;
    NAV_H = LAND ? 0 : 52;
    RAIL_W = LAND ? 72 : 0;
    PAGE_W = SW - RAIL_W;
    PAGE_H = SH - HEADER_H - NAV_H - STRIP_H;
    CARD_W = PAGE_W - 2 * PAGE_PAD;
    int32_t cols = CARD_W >= 380 ? 3 : 2;
    TILE_W = (CARD_W - (cols - 1) * 8) / cols;
}

/* ------------------------------------------------------------------ state */

static cl_platform_t plat;
static cl_snapshot_t snap;
static uint32_t snap_tick;
static cl_link_t link_state = CL_LINK_OFFLINE;
static uint32_t link_age_s;
static uint32_t link_tick;

static struct {
    char fw[24], ssid[33], ip[40], host[64];
    int8_t rssi;
    uint8_t brightness;
    bool reduce_motion, simulator, tiles;
} dev = {"0.0.0", "", "", "", 0, 80, false, false, false};

/* What the onboarding screen last showed, so it can be redrawn after a rotation. */
typedef enum { ONB_NONE = 0, ONB_WIFI, ONB_PROGRESS, ONB_HOSTS, ONB_PAIRING, ONB_MESSAGE } onb_kind_t;
static struct {
    onb_kind_t kind;
    char a[96], b[192], c[96];
    char hosts[6][48];
    uint8_t host_count;
    void (*action)(void *);
    void *user;
} onb_last;

/* ------------------------------------------------------------------ widgets */

typedef struct {
    lv_obj_t *root, *mascot, *name, *heart, *chip, *since, *helpers, *helpers_lbl, *ctx_bar, *ctx_lbl, *tok_lbl;
    char id[CL_MAX_ID];
} card_t;

typedef struct {
    lv_obj_t *root, *mascot, *name, *heart, *state, *right;
    char id[CL_MAX_ID];
} row_t;

typedef struct {
    lv_obj_t *root, *mascot, *name, *heart, *state, *helpers, *tok;
    char id[CL_MAX_ID];
} tile_t;

typedef struct {
    lv_obj_t *root, *name, *helpers, *types, *since;
    char id[CL_MAX_ID];
} agent_block_t;

typedef struct {
    lv_obj_t *name, *bar, *value;
    char id[CL_MAX_ID];
} usage_row_t;

static struct {
    lv_obj_t *scr;
    lv_obj_t *hdr_mascot, *hdr_title, *hdr_sub, *hdr_dot;
    lv_obj_t *pager, *pages[3], *nav_btn[3], *veil, *banner, *banner_lbl;
    uint8_t page;

    /* home */
    lv_obj_t *featured, *rows, *tiles_box, *hint, *empty, *layout_icon, *nav;
    lv_obj_t *strip_today, *strip_5h_bar, *strip_5h_lbl, *strip_wk_bar, *strip_wk_lbl;
    bool tiles_mode;
    tile_t tiles[CL_MAX_SESSIONS];
    uint8_t tile_count;
    card_t cards[MAX_FEATURED];
    uint8_t card_count;
    row_t rows_w[CL_MAX_SESSIONS];
    uint8_t row_count;
    char home_sig[(CL_MAX_ID + 2) * CL_MAX_SESSIONS + 12];

    /* agents */
    lv_obj_t *agents_count, *agents_caption, *agents_list, *agents_empty, *agents_empty_lbl;
    agent_block_t blocks[CL_MAX_SESSIONS];
    uint8_t block_count;
    char agents_sig[(CL_MAX_ID + 1) * CL_MAX_SESSIONS + 4];

    /* usage */
    lv_obj_t *today, *today_caption, *five_bar, *five_lbl, *seven_bar, *seven_lbl, *limits_hint, *top_list;
    usage_row_t top[MAX_TOP_TOKENS];
    uint8_t top_count;
    char usage_sig[(CL_MAX_ID + 1) * MAX_TOP_TOKENS + 4];
} d;

static struct {
    lv_obj_t *scr, *mascot, *name, *chip, *since, *reason, *helpers, *helpers_lbl, *types, *tokens, *cache,
        *ctx_bar, *ctx_lbl, *activity, *pin_btn, *pin_lbl, *gone;
    char id[CL_MAX_ID];
} det;

static struct {
    lv_obj_t *scr, *slider, *motion, *rot_lbl, *wifi, *ip, *host, *fw, *reset_lbl;
    bool reset_armed;
} set;

static uint8_t rotation_q; /* quarter turns currently applied */
static void apply_rotation(uint8_t q, bool notify);

static struct {
    lv_obj_t *scr, *body;
    void (*action)(void *);
    void *action_user;
} onb;

static lv_obj_t *toast;
static lv_timer_t *toast_timer;

/* ------------------------------------------------------------------ helpers */

static uint32_t since_snap_s(void) { return lv_tick_elaps(snap_tick) / 1000; }

static int64_t live_age(int32_t age)
{
    return age < 0 ? -1 : (int64_t)age + since_snap_s();
}

static const cl_session_t *find_session(const char *id)
{
    for (uint8_t i = 0; i < snap.session_count; i++)
        if (strcmp(snap.sessions[i].id, id) == 0) return &snap.sessions[i];
    return NULL;
}

static void show_toast(const char *text)
{
    lv_label_set_text(lv_obj_get_child(toast, 0), text);
    lv_obj_remove_flag(toast, LV_OBJ_FLAG_HIDDEN);
    lv_timer_reset(toast_timer);
    lv_timer_resume(toast_timer);
}

static void toast_hide(lv_timer_t *t)
{
    lv_obj_add_flag(toast, LV_OBJ_FLAG_HIDDEN);
    lv_timer_pause(t);
}

/* A gentle amber pulse on anything that needs you (still when reduced motion is on). */
static void border_opa_cb(void *obj, int32_t v) { lv_obj_set_style_border_opa((lv_obj_t *)obj, (lv_opa_t)v, 0); }

static void set_attention(lv_obj_t *obj, bool needs)
{
    bool pulsing = lv_anim_get(obj, border_opa_cb) != NULL;
    if (needs && !dev.reduce_motion) {
        if (pulsing) return;
        lv_anim_t a;
        lv_anim_init(&a);
        lv_anim_set_var(&a, obj);
        lv_anim_set_exec_cb(&a, border_opa_cb);
        lv_anim_set_values(&a, LV_OPA_COVER, LV_OPA_30);
        lv_anim_set_duration(&a, 700);
        lv_anim_set_reverse_duration(&a, 700);
        lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
        lv_anim_set_path_cb(&a, lv_anim_path_ease_in_out);
        lv_anim_start(&a);
    } else {
        if (pulsing) lv_anim_delete(obj, border_opa_cb);
        lv_obj_set_style_border_opa(obj, LV_OPA_COVER, 0);
    }
}

static void fmt_since(char *buf, size_t size, const cl_session_t *s)
{
    char age[16];
    switch (s->state) {
    case CL_STATE_WORKING:
        cl_fmt_age(age, sizeof(age), live_age(s->state_age_s));
        snprintf(buf, size, s->state_age_s < 0 ? "busy" : "for %s", age);
        break;
    case CL_STATE_NEEDS_ATTENTION:
        cl_fmt_age(age, sizeof(age), live_age(s->state_age_s));
        snprintf(buf, size, "%s%s%s", s->reason[0] ? s->reason : "waiting", s->state_age_s < 0 ? "" : " \xC2\xB7 ",
                 s->state_age_s < 0 ? "" : age);
        break;
    case CL_STATE_READY:
        cl_fmt_age(age, sizeof(age), live_age(s->state_age_s));
        snprintf(buf, size, s->state_age_s < 0 ? "ready for you" : "done %s ago", age);
        break;
    case CL_STATE_FAILED:
    case CL_STATE_STOPPED:
        cl_fmt_age(age, sizeof(age), live_age(s->state_age_s));
        snprintf(buf, size, "%s ago", age);
        break;
    default:
        cl_fmt_age(age, sizeof(age), live_age(s->last_activity_age_s));
        snprintf(buf, size, "last seen %s", age);
    }
    if (strncmp(buf, "done now", 8) == 0) snprintf(buf, size, "just finished");
    if (strcmp(buf, "now ago") == 0) snprintf(buf, size, "just now");
}

static void fmt_helpers(char *buf, size_t size, const cl_session_t *s)
{
    if (s->agents_active < 0) {
        snprintf(buf, size, "Helpers unknown");
        return;
    }
    if (s->agents_active == 0) {
        snprintf(buf, size, "No helpers");
        return;
    }
    int n = snprintf(buf, size, "%s%d helper%s", s->agents_partial ? "~" : "", s->agents_active,
                     s->agents_active == 1 ? "" : "s");
    for (uint8_t i = 0; i < s->agent_type_count && n > 0 && (size_t)n < size; i++)
        n += snprintf(buf + n, size - (size_t)n, "%s%s", i == 0 ? " \xC2\xB7 " : ", ", s->agent_types[i]);
}

/* ------------------------------------------------------------------ navigation */

static void open_detail(const char *id);
static void open_settings(lv_event_t *e);
static void refresh_detail(void);

static void load(lv_obj_t *scr)
{
    if (lv_screen_active() != scr) lv_screen_load_anim(scr, LV_SCREEN_LOAD_ANIM_FADE_IN, 160, 0, false);
}

static void back_to_dash(lv_event_t *e)
{
    (void)e;
    load(d.scr);
}

static void toggle_pin(const char *id)
{
    cl_session_t *s = (cl_session_t *)find_session(id);
    if (!s) return;
    s->pinned = !s->pinned;
    show_toast(s->pinned ? "Pinned to home" : "Unpinned");
    if (plat.toggle_pin) plat.toggle_pin(id, s->pinned, plat.user);
    cl_ui_set_snapshot(&snap);
}

static void session_event(lv_event_t *e)
{
    const char *id = (const char *)lv_event_get_user_data(e);
    if (lv_event_get_code(e) == LV_EVENT_LONG_PRESSED) toggle_pin(id);
    else open_detail(id);
}

static void make_session_target(lv_obj_t *obj, const char *id)
{
    lv_obj_add_flag(obj, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_add_event_cb(obj, session_event, LV_EVENT_SHORT_CLICKED, (void *)id);
    lv_obj_add_event_cb(obj, session_event, LV_EVENT_LONG_PRESSED, (void *)id);
}

static void set_page(uint8_t idx, bool scroll)
{
    d.page = idx;
    for (uint8_t i = 0; i < 3; i++) {
        lv_obj_t *lbl = lv_obj_get_child(d.nav_btn[i], 0);
        lv_obj_t *dot = lv_obj_get_child(d.nav_btn[i], 1);
        lv_obj_set_style_text_color(lbl, CL_HEX(i == idx ? CL_C_CREAM : CL_C_MUTED), 0);
        if (i == idx) lv_obj_remove_flag(dot, LV_OBJ_FLAG_HIDDEN);
        else lv_obj_add_flag(dot, LV_OBJ_FLAG_HIDDEN);
    }
    if (scroll) lv_obj_scroll_to_view(d.pages[idx], LV_ANIM_ON);
}

static void nav_clicked(lv_event_t *e) { set_page((uint8_t)(uintptr_t)lv_event_get_user_data(e), true); }

static void pager_scrolled(lv_event_t *e)
{
    (void)e;
    int32_t x = lv_obj_get_scroll_x(d.pager);
    uint8_t idx = (uint8_t)((x + PAGE_W / 2) / PAGE_W);
    if (idx > 2) idx = 2;
    if (idx != d.page) set_page(idx, false);
}

/* ------------------------------------------------------------------ home */

static lv_obj_t *page_section_title(lv_obj_t *parent, const char *text)
{
    lv_obj_t *l = cl_label(parent, &cl_font_12, CL_C_MUTED, text);
    lv_obj_set_style_pad_top(l, 4, 0);
    lv_obj_set_style_pad_left(l, 4, 0);
    return l;
}

static lv_obj_t *heart(lv_obj_t *parent)
{
    lv_obj_t *h = lv_image_create(parent);
    lv_image_set_src(h, &cl_spr_heart_x2);
    lv_obj_remove_flag(h, LV_OBJ_FLAG_CLICKABLE);
    return h;
}

static void build_card(card_t *c, lv_obj_t *parent, const cl_session_t *s)
{
    memset(c, 0, sizeof(*c));
    snprintf(c->id, sizeof(c->id), "%s", s->id);
    c->root = cl_card(parent);
    lv_obj_set_size(c->root, CARD_W, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(c->root, LV_FLEX_FLOW_ROW);
    lv_obj_set_style_pad_column(c->root, 8, 0);
    make_session_target(c->root, c->id);

    c->mascot = cl_mascot_create(c->root, 3);
    cl_mascot_set_look(c->mascot, c->id);

    lv_obj_t *col = cl_box(c->root);
    lv_obj_set_width(col, CARD_W - 20 - 66 - 8);
    lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(col, 5, 0);
    lv_obj_remove_flag(col, LV_OBJ_FLAG_CLICKABLE);

    lv_obj_t *top = cl_box(col);
    lv_obj_set_width(top, LV_PCT(100));
    lv_obj_set_flex_flow(top, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(top, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    c->name = cl_label(top, &cl_font_16, CL_C_CREAM, "");
    lv_obj_set_width(c->name, CARD_W - 20 - 66 - 8 - 20);
    cl_label_oneline(c->name);
    c->heart = heart(top);

    lv_obj_t *state = cl_box(col);
    lv_obj_set_flex_flow(state, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(state, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(state, 6, 0);
    c->chip = cl_chip(state, CL_C_SAGE, "");
    c->since = cl_label(state, &cl_font_12, CL_C_MUTED, "");
    lv_obj_set_width(c->since, 110);
    cl_label_oneline(c->since);

    lv_obj_t *help = cl_box(col);
    lv_obj_set_width(help, LV_PCT(100));
    lv_obj_set_flex_flow(help, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(help, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(help, 4, 0);
    c->helpers = cl_helpers_create(help, 3);
    c->helpers_lbl = cl_label(help, &cl_font_12, CL_C_CREAM_DIM, "");
    lv_obj_set_flex_grow(c->helpers_lbl, 1);
    cl_label_oneline(c->helpers_lbl);

    lv_obj_t *ctx = cl_box(col);
    lv_obj_set_width(ctx, LV_PCT(100));
    lv_obj_set_flex_flow(ctx, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(ctx, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(ctx, 6, 0);
    cl_label(ctx, &cl_font_12, CL_C_MUTED, "Context");
    c->ctx_bar = cl_bar(ctx, 50, CL_C_TERRACOTTA);
    c->ctx_lbl = cl_label(ctx, &cl_font_12, CL_C_CREAM_DIM, "");
    c->tok_lbl = cl_label(ctx, &cl_font_12, CL_C_CREAM_DIM, "");
    lv_obj_set_flex_grow(c->tok_lbl, 1);
    cl_label_oneline(c->tok_lbl);
    lv_obj_set_style_text_align(c->tok_lbl, LV_TEXT_ALIGN_RIGHT, 0);
}

static void update_card(card_t *c, const cl_session_t *s)
{
    char buf[96];
    lv_label_set_text(c->name, s->name[0] ? s->name : "Untitled session");
    if (s->pinned) lv_obj_remove_flag(c->heart, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(c->heart, LV_OBJ_FLAG_HIDDEN);
    uint32_t col = cl_state_color(s->state);
    cl_chip_set(c->chip, col, cl_state_label(s->state));
    fmt_since(buf, sizeof(buf), s);
    lv_label_set_text(c->since, buf);
    cl_mascot_set_mood(c->mascot, cl_mood_for_state(s->state));

    cl_helpers_set(c->helpers, s->agents_active);
    fmt_helpers(buf, sizeof(buf), s);
    lv_label_set_text(c->helpers_lbl, buf);
    lv_obj_set_style_text_color(c->helpers_lbl, CL_HEX(s->agents_active > 0 ? CL_C_CREAM_DIM : CL_C_MUTED), 0);

    char num[16];
    if (s->context_pct >= 0) {
        lv_obj_remove_flag(c->ctx_bar, LV_OBJ_FLAG_HIDDEN);
        lv_bar_set_value(c->ctx_bar, s->context_pct, LV_ANIM_OFF);
        lv_obj_set_style_bg_color(c->ctx_bar, CL_HEX(s->context_pct >= 85 ? CL_C_AMBER : CL_C_TERRACOTTA),
                                  LV_PART_INDICATOR);
        lv_label_set_text_fmt(c->ctx_lbl, "%d%%", s->context_pct);
    } else {
        /* Without the status line we still know how much is in context, just not the window size. */
        lv_obj_add_flag(c->ctx_bar, LV_OBJ_FLAG_HIDDEN);
        cl_fmt_tokens(num, sizeof(num), s->context_tokens);
        lv_label_set_text(c->ctx_lbl, num);
    }
    cl_fmt_tokens(num, sizeof(num), s->tokens);
    lv_label_set_text_fmt(c->tok_lbl, "%s total", num);

    bool needs = s->state == CL_STATE_NEEDS_ATTENTION;
    lv_obj_set_style_border_color(c->root, CL_HEX(needs ? CL_C_AMBER : CL_C_LINE), 0);
    lv_obj_set_style_border_width(c->root, needs ? 2 : 1, 0);
    lv_obj_set_style_bg_color(c->root, CL_HEX(needs ? 0x2B2A2E : CL_C_PANEL), 0);
    set_attention(c->root, needs);
}

static void build_row(row_t *r, lv_obj_t *parent, const cl_session_t *s)
{
    memset(r, 0, sizeof(*r));
    snprintf(r->id, sizeof(r->id), "%s", s->id);
    r->root = cl_card(parent);
    lv_obj_set_size(r->root, CARD_W, LV_SIZE_CONTENT);
    lv_obj_set_style_pad_ver(r->root, 6, 0);
    lv_obj_set_style_radius(r->root, 12, 0);
    lv_obj_set_flex_flow(r->root, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(r->root, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(r->root, 8, 0);
    make_session_target(r->root, r->id);
    r->mascot = cl_mascot_create(r->root, 2);
    cl_mascot_set_look(r->mascot, r->id);

    lv_obj_t *col = cl_box(r->root);
    lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
    lv_obj_remove_flag(col, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_t *top = cl_box(col);
    lv_obj_set_flex_flow(top, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(top, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(top, 4, 0);
    r->name = cl_label(top, &cl_font_14, CL_C_CREAM, "");
    lv_obj_set_width(r->name, CARD_W - 20 - 44 - 8 - 60);
    cl_label_oneline(r->name);
    r->heart = heart(top);
    r->state = cl_label(col, &cl_font_12, CL_C_SAGE, "");
    lv_obj_set_width(r->state, CARD_W - 20 - 44 - 8 - 40);
    cl_label_oneline(r->state);

    r->right = cl_label(r->root, &cl_font_12, CL_C_MUTED, "");
    lv_obj_set_flex_grow(r->right, 1);
    lv_obj_set_style_text_align(r->right, LV_TEXT_ALIGN_RIGHT, 0);
}

static void update_row(row_t *r, const cl_session_t *s)
{
    char buf[80], since[56];
    lv_label_set_text(r->name, s->name[0] ? s->name : "Untitled session");
    if (s->pinned) lv_obj_remove_flag(r->heart, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(r->heart, LV_OBJ_FLAG_HIDDEN);
    cl_mascot_set_mood(r->mascot, cl_mood_for_state(s->state));
    fmt_since(since, sizeof(since), s);
    snprintf(buf, sizeof(buf), "%s \xC2\xB7 %s", cl_state_label(s->state), since);
    lv_label_set_text(r->state, buf);
    lv_obj_set_style_text_color(r->state, CL_HEX(cl_state_color(s->state)), 0);
    if (s->agents_active > 0) lv_label_set_text_fmt(r->right, "%d " LV_SYMBOL_SHUFFLE, s->agents_active);
    else lv_label_set_text(r->right, "");
    lv_obj_set_style_border_color(r->root, CL_HEX(s->state == CL_STATE_NEEDS_ATTENTION ? CL_C_AMBER : CL_C_LINE), 0);
    set_attention(r->root, s->state == CL_STATE_NEEDS_ATTENTION);
}


static void build_tile(tile_t *t, lv_obj_t *parent, const cl_session_t *s)
{
    memset(t, 0, sizeof(*t));
    snprintf(t->id, sizeof(t->id), "%s", s->id);
    t->root = cl_card(parent);
    lv_obj_set_size(t->root, TILE_W, LV_SIZE_CONTENT);
    lv_obj_set_style_pad_all(t->root, 8, 0);
    lv_obj_set_style_pad_row(t->root, 3, 0);
    lv_obj_set_flex_flow(t->root, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(t->root, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    make_session_target(t->root, t->id);

    t->heart = heart(t->root);
    lv_obj_add_flag(t->heart, LV_OBJ_FLAG_FLOATING);
    lv_obj_align(t->heart, LV_ALIGN_TOP_RIGHT, 0, 0);
    t->mascot = cl_mascot_create(t->root, 3);
    cl_mascot_set_look(t->mascot, t->id);

    t->name = cl_label(t->root, &cl_font_14, CL_C_CREAM, "");
    lv_obj_set_width(t->name, TILE_W - 16);
    cl_label_oneline(t->name);
    lv_obj_set_style_text_align(t->name, LV_TEXT_ALIGN_CENTER, 0);
    t->state = cl_label(t->root, &cl_font_12, CL_C_SAGE, "");
    lv_obj_set_width(t->state, TILE_W - 16);
    cl_label_oneline(t->state);
    lv_obj_set_style_text_align(t->state, LV_TEXT_ALIGN_CENTER, 0);

    lv_obj_t *foot = cl_box(t->root);
    lv_obj_set_flex_flow(foot, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(foot, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(foot, 4, 0);
    t->helpers = cl_helpers_create(foot, 3);
    t->tok = cl_label(foot, &cl_font_12, CL_C_MUTED, "");
}

static void update_tile(tile_t *t, const cl_session_t *s)
{
    char since[56], buf[80], tok[16];
    lv_label_set_text(t->name, s->name[0] ? s->name : "Untitled session");
    if (s->pinned) lv_obj_remove_flag(t->heart, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(t->heart, LV_OBJ_FLAG_HIDDEN);
    cl_mascot_set_mood(t->mascot, cl_mood_for_state(s->state));
    fmt_since(since, sizeof(since), s);
    snprintf(buf, sizeof(buf), "%s \xC2\xB7 %s", cl_state_label(s->state), since);
    lv_label_set_text(t->state, buf);
    lv_obj_set_style_text_color(t->state, CL_HEX(cl_state_color(s->state)), 0);
    cl_helpers_set(t->helpers, s->agents_active);
    cl_fmt_tokens(tok, sizeof(tok), s->tokens);
    lv_label_set_text_fmt(t->tok, "%s total", tok);
    bool needs = s->state == CL_STATE_NEEDS_ATTENTION;
    lv_obj_set_style_border_color(t->root, CL_HEX(needs ? CL_C_AMBER : CL_C_LINE), 0);
    lv_obj_set_style_border_width(t->root, needs ? 2 : 1, 0);
    lv_obj_set_style_bg_color(t->root, CL_HEX(needs ? 0x2B2A2E : CL_C_PANEL), 0);
    set_attention(t->root, needs);
}

/* Big cards: everything that needs you, then pinned sessions (the service already sorts them in that
 * order). With neither, the first two. */
static uint8_t featured_indices(uint8_t *out)
{
    uint8_t n = 0;
    for (uint8_t i = 0; i < snap.session_count && n < MAX_FEATURED; i++)
        if (snap.sessions[i].pinned || snap.sessions[i].state == CL_STATE_NEEDS_ATTENTION) out[n++] = i;
    if (n == 0)
        for (uint8_t i = 0; i < snap.session_count && n < 2; i++) out[n++] = i;
    return n;
}

static bool any_pinned(void)
{
    for (uint8_t i = 0; i < snap.session_count; i++)
        if (snap.sessions[i].pinned) return true;
    return false;
}

static void show(lv_obj_t *o, bool visible)
{
    if (visible) lv_obj_remove_flag(o, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(o, LV_OBJ_FLAG_HIDDEN);
}

/* ------------------------------------------------------------------ usage strip (bottom of the dashboard) */

static void strip_limit(lv_obj_t *bar, lv_obj_t *lbl, const cl_rate_window_t *w)
{
    if (!w->present) {
        lv_bar_set_value(bar, 0, LV_ANIM_OFF);
        lv_label_set_text(lbl, "\xE2\x80\x94");
        return;
    }
    lv_bar_set_value(bar, w->used_pct, LV_ANIM_OFF);
    lv_obj_set_style_bg_color(bar, CL_HEX(w->used_pct >= 80 ? CL_C_AMBER : CL_C_TERRACOTTA), LV_PART_INDICATOR);
    lv_label_set_text_fmt(lbl, "%d%%", w->used_pct);
}

static void update_strip(void)
{
    char today[16];
    cl_fmt_tokens(today, sizeof(today), snap.daily_tokens);
    lv_label_set_text_fmt(d.strip_today, "Today %s", today);
    strip_limit(d.strip_5h_bar, d.strip_5h_lbl, &snap.five_hour);
    strip_limit(d.strip_wk_bar, d.strip_wk_lbl, &snap.seven_day);
}

static void strip_group(lv_obj_t *parent, const char *name, int32_t bar_w, lv_obj_t **bar, lv_obj_t **lbl)
{
    lv_obj_t *g = cl_box(parent);
    lv_obj_set_flex_flow(g, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(g, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(g, 5, 0);
    cl_label(g, &cl_font_12, CL_C_MUTED, name);
    *bar = cl_bar(g, bar_w, CL_C_TERRACOTTA);
    lv_obj_set_height(*bar, 6);
    *lbl = cl_label(g, &cl_font_12, CL_C_CREAM_DIM, "");
    lv_obj_set_width(*lbl, 28);
}

static void build_strip(lv_obj_t *scr)
{
    lv_obj_t *s = cl_box(scr);
    lv_obj_set_pos(s, RAIL_W, HEADER_H + PAGE_H);
    lv_obj_set_size(s, PAGE_W, STRIP_H);
    lv_obj_set_style_pad_hor(s, 10, 0);
    lv_obj_set_style_bg_color(s, CL_HEX(CL_C_BG), 0);
    lv_obj_set_style_bg_opa(s, LV_OPA_COVER, 0);
    lv_obj_set_style_border_side(s, LV_BORDER_SIDE_TOP, 0);
    lv_obj_set_style_border_color(s, CL_HEX(CL_C_LINE), 0);
    lv_obj_set_style_border_width(s, 1, 0);
    lv_obj_set_flex_flow(s, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(s, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    d.strip_today = cl_label(s, &cl_font_12, CL_C_CREAM_DIM, "");
    int32_t bar_w = LAND ? 90 : 40;
    strip_group(s, "5h", bar_w, &d.strip_5h_bar, &d.strip_5h_lbl);
    strip_group(s, "Week", bar_w, &d.strip_wk_bar, &d.strip_wk_lbl);
}

/* Tile mode: every session as an equal tile, in the service's order (pinned first). */
static void update_home_tiles(void)
{
    char sig[sizeof(d.home_sig)];
    size_t n = (size_t)snprintf(sig, sizeof(sig), "T|");
    for (uint8_t i = 0; i < snap.session_count; i++) n += (size_t)snprintf(sig + n, sizeof(sig) - n, "%s,", snap.sessions[i].id);
    if (strcmp(sig, d.home_sig) != 0) {
        strcpy(d.home_sig, sig);
        lv_obj_clean(d.featured);
        lv_obj_clean(d.rows);
        lv_obj_clean(d.tiles_box);
        d.card_count = d.row_count = d.tile_count = 0;
        for (uint8_t i = 0; i < snap.session_count; i++) build_tile(&d.tiles[d.tile_count++], d.tiles_box, &snap.sessions[i]);
    }
    for (uint8_t i = 0; i < d.tile_count; i++) {
        const cl_session_t *s = find_session(d.tiles[i].id);
        if (s) update_tile(&d.tiles[i], s);
    }
    show(d.tiles_box, true);
    show(d.featured, false);
    show(d.rows, false);
}

static void update_home(void)
{
    bool empty = snap.session_count == 0;
    show(d.empty, empty);
    show(d.hint, !empty && !any_pinned());

    update_strip();

    if (d.tiles_mode) {
        update_home_tiles();
        return;
    }
    show(d.tiles_box, false);
    show(d.featured, true);
    show(d.rows, true);

    uint8_t feat[MAX_FEATURED];
    uint8_t nf = featured_indices(feat);
    bool is_feat[CL_MAX_SESSIONS] = {0};
    for (uint8_t i = 0; i < nf; i++) is_feat[feat[i]] = true;

    char sig[sizeof(d.home_sig)];
    size_t n = (size_t)snprintf(sig, sizeof(sig), "L|");
    for (uint8_t i = 0; i < nf; i++) n += (size_t)snprintf(sig + n, sizeof(sig) - n, "%s,", snap.sessions[feat[i]].id);
    n += (size_t)snprintf(sig + n, sizeof(sig) - n, "|");
    for (uint8_t i = 0; i < snap.session_count; i++)
        if (!is_feat[i]) n += (size_t)snprintf(sig + n, sizeof(sig) - n, "%s,", snap.sessions[i].id);

    if (strcmp(sig, d.home_sig) != 0) {
        strcpy(d.home_sig, sig);
        lv_obj_clean(d.featured);
        lv_obj_clean(d.rows);
        lv_obj_clean(d.tiles_box);
        d.card_count = 0;
        d.row_count = 0;
        d.tile_count = 0;
        for (uint8_t i = 0; i < nf; i++) build_card(&d.cards[d.card_count++], d.featured, &snap.sessions[feat[i]]);
        for (uint8_t i = 0; i < snap.session_count; i++)
            if (!is_feat[i]) build_row(&d.rows_w[d.row_count++], d.rows, &snap.sessions[i]);
    }
    for (uint8_t i = 0; i < d.card_count; i++) {
        const cl_session_t *s = find_session(d.cards[i].id);
        if (s) update_card(&d.cards[i], s);
    }
    for (uint8_t i = 0; i < d.row_count; i++) {
        const cl_session_t *s = find_session(d.rows_w[i].id);
        if (s) update_row(&d.rows_w[i], s);
    }
}

static lv_obj_t *make_page(lv_obj_t *pager)
{
    lv_obj_t *p = lv_obj_create(pager);
    lv_obj_remove_style_all(p);
    lv_obj_set_size(p, PAGE_W, PAGE_H);
    lv_obj_set_style_pad_all(p, PAGE_PAD, 0);
    lv_obj_set_style_pad_row(p, 8, 0);
    lv_obj_set_flex_flow(p, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_scroll_dir(p, LV_DIR_VER);
    lv_obj_set_scrollbar_mode(p, LV_SCROLLBAR_MODE_ACTIVE);
    lv_obj_set_style_bg_color(p, CL_HEX(CL_C_CREAM), LV_PART_SCROLLBAR);
    lv_obj_set_style_bg_opa(p, LV_OPA_40, LV_PART_SCROLLBAR);
    lv_obj_set_style_width(p, 3, LV_PART_SCROLLBAR);
    lv_obj_add_flag(p, LV_OBJ_FLAG_SNAPPABLE);
    return p;
}

static lv_obj_t *hero(lv_obj_t *parent, cl_mood_t mood, const char *title, const char *body)
{
    lv_obj_t *h = cl_box(parent);
    lv_obj_set_width(h, CARD_W);
    lv_obj_set_flex_flow(h, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(h, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_row(h, 8, 0);
    lv_obj_set_style_pad_ver(h, 16, 0);
    lv_obj_t *m = cl_mascot_create(h, 5);
    cl_mascot_set_mood(m, mood);
    cl_label(h, &cl_font_20, CL_C_CREAM, title);
    lv_obj_t *b = cl_label(h, &cl_font_14, CL_C_CREAM_DIM, body);
    lv_obj_set_width(b, CARD_W - 24);
    lv_label_set_long_mode(b, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_style_text_align(b, LV_TEXT_ALIGN_CENTER, 0);
    return h;
}

static void build_home(lv_obj_t *p)
{
    d.empty = hero(p, CL_MOOD_READY, "All quiet",
                   "No Claude Code sessions right now. Start one and I'll keep an eye on it.");
    lv_obj_add_flag(d.empty, LV_OBJ_FLAG_HIDDEN);

    d.featured = cl_box(p);
    lv_obj_set_flex_flow(d.featured, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(d.featured, 8, 0);

    d.rows = cl_box(p);
    lv_obj_set_flex_flow(d.rows, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(d.rows, 6, 0);

    d.tiles_box = cl_box(p);
    lv_obj_set_width(d.tiles_box, CARD_W);
    lv_obj_set_flex_flow(d.tiles_box, LV_FLEX_FLOW_ROW_WRAP);
    lv_obj_set_style_pad_row(d.tiles_box, 8, 0);
    lv_obj_set_style_pad_column(d.tiles_box, 8, 0);

    d.hint = cl_label(p, &cl_font_12, CL_C_MUTED, "Long-press a session to pin it to the top");
    lv_obj_set_style_pad_left(d.hint, 4, 0);
}

/* ------------------------------------------------------------------ agents */

static void build_agents(lv_obj_t *p)
{
    lv_obj_t *top = cl_card(p);
    lv_obj_set_size(top, CARD_W, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(top, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(top, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(top, 12, 0);
    d.agents_count = cl_label(top, &cl_font_44, CL_C_SAGE, "0");
    lv_obj_t *col = cl_box(top);
    lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
    cl_label(col, &cl_font_16, CL_C_CREAM, "Busy little helpers");
    d.agents_caption = cl_label(col, &cl_font_12, CL_C_MUTED, "subagents running now");

    d.agents_list = cl_box(p);
    lv_obj_set_flex_flow(d.agents_list, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(d.agents_list, 8, 0);

    d.agents_empty = cl_box(p);
    lv_obj_set_width(d.agents_empty, CARD_W);
    lv_obj_set_flex_flow(d.agents_empty, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(d.agents_empty, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_ver(d.agents_empty, 24, 0);
    lv_obj_set_style_pad_row(d.agents_empty, 10, 0);
    lv_obj_t *nap = lv_image_create(d.agents_empty);
    lv_image_set_src(nap, &cl_spr_helper_x2);
    d.agents_empty_lbl = cl_label(d.agents_empty, &cl_font_14, CL_C_MUTED, "");
    lv_obj_set_width(d.agents_empty_lbl, CARD_W - 40);
    lv_label_set_long_mode(d.agents_empty_lbl, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_style_text_align(d.agents_empty_lbl, LV_TEXT_ALIGN_CENTER, 0);
}

static void update_agents(void)
{
    int total = 0;
    bool unknown = false;
    char sig[sizeof(d.agents_sig)];
    size_t n = 0;
    sig[0] = '\0';
    for (uint8_t i = 0; i < snap.session_count; i++) {
        const cl_session_t *s = &snap.sessions[i];
        if (s->agents_active < 0) unknown = true;
        if (s->agents_active > 0) {
            total += s->agents_active;
            n += (size_t)snprintf(sig + n, sizeof(sig) - n, "%s,", s->id);
        }
    }
    if (unknown && total == 0) lv_label_set_text(d.agents_count, "?");
    else lv_label_set_text_fmt(d.agents_count, "%d", total);
    lv_label_set_text(d.agents_caption, total == 1 ? "subagent running now" : "subagents running now");

    if (strcmp(sig, d.agents_sig) != 0) {
        strcpy(d.agents_sig, sig);
        lv_obj_clean(d.agents_list);
        d.block_count = 0;
        for (uint8_t i = 0; i < snap.session_count; i++) {
            const cl_session_t *s = &snap.sessions[i];
            if (s->agents_active <= 0) continue;
            agent_block_t *b = &d.blocks[d.block_count++];
            snprintf(b->id, sizeof(b->id), "%s", s->id);
            b->root = cl_card(d.agents_list);
            lv_obj_set_size(b->root, CARD_W, LV_SIZE_CONTENT);
            lv_obj_set_flex_flow(b->root, LV_FLEX_FLOW_COLUMN);
            lv_obj_set_style_pad_row(b->root, 6, 0);
            make_session_target(b->root, b->id);
            b->name = cl_label(b->root, &cl_font_16, CL_C_CREAM, "");
            lv_obj_set_width(b->name, CARD_W - 20);
            cl_label_oneline(b->name);
            b->helpers = cl_helpers_create(b->root, 8);
            b->types = cl_label(b->root, &cl_font_12, CL_C_CREAM_DIM, "");
            lv_obj_set_width(b->types, CARD_W - 20);
            lv_label_set_long_mode(b->types, LV_LABEL_LONG_MODE_WRAP);
            b->since = cl_label(b->root, &cl_font_12, CL_C_MUTED, "");
        }
    }
    for (uint8_t i = 0; i < d.block_count; i++) {
        agent_block_t *b = &d.blocks[i];
        const cl_session_t *s = find_session(b->id);
        if (!s) continue;
        lv_label_set_text(b->name, s->name);
        cl_helpers_set(b->helpers, s->agents_active);
        char types[CL_MAX_AGENT_TYPES * (CL_MAX_AGENT_TYPE + 4)] = "";
        size_t tn = 0;
        for (uint8_t k = 0; k < s->agent_type_count; k++)
            tn += (size_t)snprintf(types + tn, sizeof(types) - tn, "%s%s", k ? " \xC2\xB7 " : "", s->agent_types[k]);
        lv_label_set_text(b->types, s->agent_type_count ? types : "Type not reported");
        char age[16];
        cl_fmt_age(age, sizeof(age), live_age(s->agents_oldest_age_s));
        if (s->agents_oldest_age_s >= 0) lv_label_set_text_fmt(b->since, "Oldest running for %s", age);
        else lv_label_set_text(b->since, "");
    }

    if (d.block_count == 0) {
        lv_obj_remove_flag(d.agents_empty, LV_OBJ_FLAG_HIDDEN);
        lv_label_set_text(d.agents_empty_lbl,
                          !snap.hooks_installed ? "I can't see helpers yet. Run claudette setup on your Mac to turn on hooks."
                                                : "No helpers out right now. They're having a nap.");
    } else {
        lv_obj_add_flag(d.agents_empty, LV_OBJ_FLAG_HIDDEN);
    }
}

/* ------------------------------------------------------------------ usage */

static lv_obj_t *limit_row(lv_obj_t *parent, const char *title, lv_obj_t **bar, lv_obj_t **lbl)
{
    lv_obj_t *r = cl_box(parent);
    lv_obj_set_width(r, LV_PCT(100));
    lv_obj_set_flex_flow(r, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(r, 4, 0);
    lv_obj_t *top = cl_box(r);
    lv_obj_set_width(top, LV_PCT(100));
    lv_obj_set_flex_flow(top, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(top, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    cl_label(top, &cl_font_14, CL_C_CREAM, title);
    *lbl = cl_label(top, &cl_font_12, CL_C_MUTED, "");
    *bar = cl_bar(r, CARD_W - 20, CL_C_TERRACOTTA);
    return r;
}

static void build_usage(lv_obj_t *p)
{
    lv_obj_t *today = cl_card(p);
    lv_obj_set_size(today, CARD_W, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(today, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(today, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    d.today = cl_label(today, &cl_font_44, CL_C_TERRACOTTA, "");
    d.today_caption = cl_label(today, &cl_font_14, CL_C_CREAM_DIM, "tokens today");

    lv_obj_t *limits = cl_card(p);
    lv_obj_set_size(limits, CARD_W, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(limits, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(limits, 10, 0);
    limit_row(limits, "5-hour limit", &d.five_bar, &d.five_lbl);
    limit_row(limits, "Weekly limit", &d.seven_bar, &d.seven_lbl);
    d.limits_hint = cl_label(limits, &cl_font_12, CL_C_MUTED,
                             "No plan limits reported yet. Claude Code shares them through its status line, which only runs "
                             "in the terminal (not the desktop app).");
    lv_obj_set_width(d.limits_hint, CARD_W - 20);
    lv_label_set_long_mode(d.limits_hint, LV_LABEL_LONG_MODE_WRAP);

    page_section_title(p, "BIGGEST SESSIONS");
    d.top_list = cl_card(p);
    lv_obj_set_size(d.top_list, CARD_W, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(d.top_list, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(d.top_list, 8, 0);

    lv_obj_t *note = cl_label(p, &cl_font_12, CL_C_MUTED,
                              "Total = all the work a session has done (input, output, cache writes, its helpers too). "
                              "Context = how much it's holding in memory right now. They're different things!");
    lv_obj_set_width(note, CARD_W - 8);
    lv_label_set_long_mode(note, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_style_pad_left(note, 4, 0);
}

static void set_limit(lv_obj_t *bar, lv_obj_t *lbl, const cl_rate_window_t *w)
{
    if (!w->present) {
        lv_bar_set_value(bar, 0, LV_ANIM_OFF);
        lv_label_set_text(lbl, "\xE2\x80\x94");
        return;
    }
    lv_bar_set_value(bar, w->used_pct, LV_ANIM_OFF);
    lv_obj_set_style_bg_color(bar, CL_HEX(w->used_pct >= 80 ? CL_C_AMBER : CL_C_TERRACOTTA), LV_PART_INDICATOR);
    if (w->resets_in_s >= 0) {
        char age[16];
        int64_t left = (int64_t)w->resets_in_s - since_snap_s();
        cl_fmt_age(age, sizeof(age), left < 0 ? 0 : left);
        lv_label_set_text_fmt(lbl, "%d%% \xC2\xB7 resets in %s", w->used_pct, age);
    } else {
        lv_label_set_text_fmt(lbl, "%d%%", w->used_pct);
    }
}

static void update_usage(void)
{
    char buf[24];
    cl_fmt_tokens(buf, sizeof(buf), snap.daily_tokens);
    lv_label_set_text(d.today, buf);
    lv_label_set_text(d.today_caption, snap.daily_tokens < 0 ? "today's tokens unavailable" : "tokens today");
    set_limit(d.five_bar, d.five_lbl, &snap.five_hour);
    set_limit(d.seven_bar, d.seven_lbl, &snap.seven_day);
    if (snap.five_hour.present || snap.seven_day.present) lv_obj_add_flag(d.limits_hint, LV_OBJ_FLAG_HIDDEN);
    else lv_obj_remove_flag(d.limits_hint, LV_OBJ_FLAG_HIDDEN);

    /* top sessions by tokens */
    uint8_t idx[MAX_TOP_TOKENS];
    uint8_t n = 0;
    bool used[CL_MAX_SESSIONS] = {0};
    while (n < MAX_TOP_TOKENS) {
        int best = -1;
        for (uint8_t i = 0; i < snap.session_count; i++)
            if (!used[i] && snap.sessions[i].tokens > 0 &&
                (best < 0 || snap.sessions[i].tokens > snap.sessions[best].tokens))
                best = i;
        if (best < 0) break;
        used[best] = true;
        idx[n++] = (uint8_t)best;
    }
    char sig[sizeof(d.usage_sig)];
    size_t sn = 0;
    sig[0] = '\0';
    for (uint8_t i = 0; i < n; i++) sn += (size_t)snprintf(sig + sn, sizeof(sig) - sn, "%s,", snap.sessions[idx[i]].id);
    if (strcmp(sig, d.usage_sig) != 0 || n == 0) {
        strcpy(d.usage_sig, sig);
        lv_obj_clean(d.top_list);
        d.top_count = 0;
        if (n == 0) cl_label(d.top_list, &cl_font_12, CL_C_MUTED, "No token data yet.");
        for (uint8_t i = 0; i < n; i++) {
            usage_row_t *u = &d.top[d.top_count++];
            snprintf(u->id, sizeof(u->id), "%s", snap.sessions[idx[i]].id);
            lv_obj_t *r = cl_box(d.top_list);
            lv_obj_set_width(r, LV_PCT(100));
            lv_obj_set_flex_flow(r, LV_FLEX_FLOW_ROW_WRAP);
            lv_obj_set_flex_align(r, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
            lv_obj_set_style_pad_row(r, 3, 0);
            make_session_target(r, u->id);
            u->name = cl_label(r, &cl_font_14, CL_C_CREAM, "");
            lv_obj_set_width(u->name, CARD_W - 20 - 70);
            cl_label_oneline(u->name);
            u->value = cl_label(r, &cl_font_12, CL_C_CREAM_DIM, "");
            u->bar = cl_bar(r, CARD_W - 20, CL_C_SAGE);
            lv_obj_set_height(u->bar, 6);
        }
    }
    int64_t max = n ? snap.sessions[idx[0]].tokens : 1;
    for (uint8_t i = 0; i < d.top_count; i++) {
        usage_row_t *u = &d.top[i];
        const cl_session_t *s = find_session(u->id);
        if (!s) continue;
        lv_label_set_text(u->name, s->name);
        cl_fmt_tokens(buf, sizeof(buf), s->tokens);
        lv_label_set_text(u->value, buf);
        lv_bar_set_value(u->bar, max > 0 ? (int32_t)(s->tokens * 100 / max) : 0, LV_ANIM_OFF);
    }
}

/* ------------------------------------------------------------------ header + freshness */

static void update_header(void)
{
    char sub[96], age[16];
    const char *host = snap.host_name[0] ? snap.host_name : (dev.host[0] ? dev.host : "your Mac");
    uint32_t last_ok = link_age_s + lv_tick_elaps(link_tick) / 1000;
    cl_fmt_age(age, sizeof(age), last_ok);
    uint32_t dot = CL_C_SAGE;
    switch (link_state) {
    case CL_LINK_LIVE:
        if (snap.collection == CL_COLLECTION_HEALTHY) snprintf(sub, sizeof(sub), "%s \xC2\xB7 live", host);
        else {
            snprintf(sub, sizeof(sub), "%s", snap.collection_message[0] ? snap.collection_message : "Some data missing");
            dot = CL_C_AMBER;
        }
        break;
    case CL_LINK_STALE:
        snprintf(sub, sizeof(sub), "%s \xC2\xB7 %s old", host, age);
        dot = CL_C_AMBER;
        break;
    default:
        snprintf(sub, sizeof(sub), "Sleeping \xC2\xB7 last seen %s", age);
        dot = CL_C_GREY;
    }
    lv_label_set_text(d.hdr_sub, sub);
    lv_obj_set_style_bg_color(d.hdr_dot, CL_HEX(dot), 0);

    cl_mood_t mood = CL_MOOD_IDLE;
    if (link_state == CL_LINK_OFFLINE) mood = CL_MOOD_SLEEPING;
    else {
        bool needs = false, working = false, failed = false;
        for (uint8_t i = 0; i < snap.session_count; i++) {
            needs |= snap.sessions[i].state == CL_STATE_NEEDS_ATTENTION;
            working |= snap.sessions[i].state == CL_STATE_WORKING;
            failed |= snap.sessions[i].state == CL_STATE_FAILED && snap.sessions[i].pinned;
        }
        mood = needs ? CL_MOOD_NEEDS_YOU : working ? CL_MOOD_WORKING : failed ? CL_MOOD_ERROR
               : snap.session_count ? CL_MOOD_READY : CL_MOOD_IDLE;
    }
    cl_mascot_set_mood(d.hdr_mascot, mood);

    if (link_state == CL_LINK_LIVE) {
        lv_obj_add_flag(d.veil, LV_OBJ_FLAG_HIDDEN);
        lv_obj_add_flag(d.banner, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_remove_flag(d.veil, LV_OBJ_FLAG_HIDDEN);
        lv_obj_remove_flag(d.banner, LV_OBJ_FLAG_HIDDEN);
        if (link_state == CL_LINK_STALE)
            lv_label_set_text_fmt(d.banner_lbl, LV_SYMBOL_REFRESH "  Reconnecting\xE2\x80\xA6 data is %s old", age);
        else
            lv_label_set_text_fmt(d.banner_lbl, "Can't reach %s. Mac asleep?", host);
        lv_obj_set_style_bg_color(d.banner, CL_HEX(link_state == CL_LINK_STALE ? CL_C_AMBER : CL_C_GREY), 0);
    }
}

static void refresh_times(void)
{
    if (!snap.valid) return;
    char buf[96];
    for (uint8_t i = 0; i < d.card_count; i++) {
        const cl_session_t *s = find_session(d.cards[i].id);
        if (!s) continue;
        fmt_since(buf, sizeof(buf), s);
        lv_label_set_text(d.cards[i].since, buf);
    }
    for (uint8_t i = 0; i < d.row_count; i++) {
        const cl_session_t *s = find_session(d.rows_w[i].id);
        if (s) update_row(&d.rows_w[i], s);
    }
    for (uint8_t i = 0; i < d.tile_count; i++) {
        const cl_session_t *s = find_session(d.tiles[i].id);
        if (s) update_tile(&d.tiles[i], s);
    }
}

static void second_tick(lv_timer_t *t)
{
    (void)t;
    if (lv_screen_active() == d.scr) {
        update_header();
        refresh_times();
    } else if (lv_screen_active() == det.scr) {
        refresh_detail();
    }
}

/* ------------------------------------------------------------------ dashboard */

/* The header button shows the layout you'd switch to. */
static void apply_layout(bool tiles)
{
    d.tiles_mode = tiles;
    dev.tiles = tiles;
    lv_image_set_src(d.layout_icon, tiles ? &cl_spr_ico_list_x2 : &cl_spr_ico_grid_x2);
    d.home_sig[0] = '\0';
    update_home();
    lv_obj_scroll_to_y(d.pages[0], 0, LV_ANIM_OFF);
}

static void layout_clicked(lv_event_t *e)
{
    (void)e;
    apply_layout(!d.tiles_mode);
    show_toast(d.tiles_mode ? "Tiles" : "List");
    if (plat.set_layout) plat.set_layout(d.tiles_mode, plat.user);
}

static void build_dashboard(void)
{
    d.scr = cl_screen();

    lv_obj_t *hdr = cl_box(d.scr);
    lv_obj_set_size(hdr, SW, HEADER_H);
    lv_obj_set_style_pad_hor(hdr, 8, 0);
    lv_obj_set_flex_flow(hdr, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(hdr, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(hdr, 6, 0);
    d.hdr_mascot = cl_mascot_create(hdr, 2);
    lv_obj_t *titles = cl_box(hdr);
    lv_obj_set_flex_flow(titles, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_grow(titles, 1);
    d.hdr_title = cl_label(titles, &cl_font_20, CL_C_CREAM, "Claudette");
    lv_obj_t *subrow = cl_box(titles);
    lv_obj_set_flex_flow(subrow, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(subrow, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(subrow, 5, 0);
    d.hdr_dot = cl_box(subrow);
    lv_obj_set_size(d.hdr_dot, 7, 7);
    lv_obj_set_style_radius(d.hdr_dot, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_opa(d.hdr_dot, LV_OPA_COVER, 0);
    d.hdr_sub = cl_label(subrow, &cl_font_12, CL_C_MUTED, "");
    lv_obj_set_width(d.hdr_sub, SW - 172);
    cl_label_oneline(d.hdr_sub);

    lv_obj_t *layout = lv_button_create(hdr);
    lv_obj_remove_style_all(layout);
    lv_obj_set_size(layout, 44, 44);
    lv_obj_set_style_radius(layout, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(layout, CL_HEX(CL_C_PANEL_HI), LV_STATE_PRESSED);
    lv_obj_set_style_bg_opa(layout, LV_OPA_COVER, LV_STATE_PRESSED);
    d.layout_icon = lv_image_create(layout);
    lv_obj_remove_flag(d.layout_icon, LV_OBJ_FLAG_CLICKABLE);
    lv_obj_center(d.layout_icon);
    lv_obj_add_event_cb(layout, layout_clicked, LV_EVENT_CLICKED, NULL);

    lv_obj_t *gear = lv_button_create(hdr);
    lv_obj_remove_style_all(gear);
    lv_obj_set_size(gear, 44, 44);
    lv_obj_set_style_radius(gear, LV_RADIUS_CIRCLE, 0);
    lv_obj_set_style_bg_color(gear, CL_HEX(CL_C_PANEL_HI), LV_STATE_PRESSED);
    lv_obj_set_style_bg_opa(gear, LV_OPA_COVER, LV_STATE_PRESSED);
    lv_obj_t *gl = cl_label(gear, &lv_font_montserrat_20, CL_C_CREAM_DIM, LV_SYMBOL_SETTINGS);
    lv_obj_center(gl);
    lv_obj_add_event_cb(gear, open_settings, LV_EVENT_CLICKED, NULL);

    d.pager = lv_obj_create(d.scr);
    lv_obj_remove_style_all(d.pager);
    lv_obj_set_pos(d.pager, RAIL_W, HEADER_H);
    lv_obj_set_size(d.pager, PAGE_W, PAGE_H);
    lv_obj_set_flex_flow(d.pager, LV_FLEX_FLOW_ROW);
    lv_obj_set_scroll_dir(d.pager, LV_DIR_HOR);
    lv_obj_set_scroll_snap_x(d.pager, LV_SCROLL_SNAP_START);
    lv_obj_add_flag(d.pager, LV_OBJ_FLAG_SCROLL_ONE);
    lv_obj_remove_flag(d.pager, LV_OBJ_FLAG_SCROLL_ELASTIC);
    lv_obj_set_scrollbar_mode(d.pager, LV_SCROLLBAR_MODE_OFF);
    lv_obj_add_event_cb(d.pager, pager_scrolled, LV_EVENT_SCROLL_END, NULL);
    for (int i = 0; i < 3; i++) d.pages[i] = make_page(d.pager);
    build_home(d.pages[0]);
    build_agents(d.pages[1]);
    build_usage(d.pages[2]);
    lv_image_set_src(d.layout_icon, &cl_spr_ico_grid_x2);

    build_strip(d.scr);

    d.veil = cl_box(d.scr);
    lv_obj_set_pos(d.veil, RAIL_W, HEADER_H);
    lv_obj_set_size(d.veil, PAGE_W, PAGE_H + STRIP_H);
    lv_obj_set_style_bg_color(d.veil, CL_HEX(CL_C_BG), 0);
    lv_obj_set_style_bg_opa(d.veil, LV_OPA_50, 0);
    lv_obj_remove_flag(d.veil, LV_OBJ_FLAG_CLICKABLE);

    d.banner = cl_box(d.scr);
    lv_obj_set_size(d.banner, PAGE_W - 16, 30);
    lv_obj_align(d.banner, LV_ALIGN_BOTTOM_MID, RAIL_W / 2, -NAV_H - STRIP_H - 8);
    lv_obj_set_style_radius(d.banner, 15, 0);
    lv_obj_set_style_bg_opa(d.banner, LV_OPA_COVER, 0);
    lv_obj_remove_flag(d.banner, LV_OBJ_FLAG_CLICKABLE);
    d.banner_lbl = cl_label(d.banner, &cl_font_12, CL_C_BG, "");
    lv_obj_center(d.banner_lbl);

    /* Navigation: a bar along the bottom in portrait, a rail down the left in landscape. */
    lv_obj_t *nav = cl_box(d.scr);
    d.nav = nav;
    lv_obj_set_style_bg_color(nav, CL_HEX(CL_C_PANEL), 0);
    lv_obj_set_style_bg_opa(nav, LV_OPA_COVER, 0);
    lv_obj_set_style_border_color(nav, CL_HEX(CL_C_LINE), 0);
    lv_obj_set_style_border_width(nav, 1, 0);
    if (LAND) {
        lv_obj_set_pos(nav, 0, HEADER_H);
        lv_obj_set_size(nav, RAIL_W, SH - HEADER_H);
        lv_obj_set_style_border_side(nav, LV_BORDER_SIDE_RIGHT, 0);
        lv_obj_set_flex_flow(nav, LV_FLEX_FLOW_COLUMN);
    } else {
        lv_obj_set_size(nav, SW, NAV_H);
        lv_obj_align(nav, LV_ALIGN_BOTTOM_MID, 0, 0);
        lv_obj_set_style_border_side(nav, LV_BORDER_SIDE_TOP, 0);
        lv_obj_set_flex_flow(nav, LV_FLEX_FLOW_ROW);
    }
    static const char *names[3] = {"Home", "Agents", "Usage"};
    for (uintptr_t i = 0; i < 3; i++) {
        lv_obj_t *b = lv_button_create(nav);
        lv_obj_remove_style_all(b);
        if (LAND) lv_obj_set_size(b, RAIL_W, 60);
        else lv_obj_set_size(b, SW / 3, NAV_H);
        lv_obj_set_style_bg_color(b, CL_HEX(CL_C_PANEL_HI), LV_STATE_PRESSED);
        lv_obj_set_style_bg_opa(b, LV_OPA_COVER, LV_STATE_PRESSED);
        lv_obj_t *l = cl_label(b, &cl_font_14, CL_C_MUTED, names[i]);
        lv_obj_align(l, LV_ALIGN_CENTER, LAND ? 2 : 0, LAND ? 0 : 2);
        lv_obj_t *dot = cl_box(b);
        lv_obj_set_style_radius(dot, 2, 0);
        lv_obj_set_style_bg_color(dot, CL_HEX(CL_C_TERRACOTTA), 0);
        lv_obj_set_style_bg_opa(dot, LV_OPA_COVER, 0);
        if (LAND) {
            lv_obj_set_size(dot, 4, 18);
            lv_obj_align(dot, LV_ALIGN_LEFT_MID, 4, 0);
        } else {
            lv_obj_set_size(dot, 18, 4);
            lv_obj_align(dot, LV_ALIGN_TOP_MID, 0, 6);
        }
        lv_obj_add_event_cb(b, nav_clicked, LV_EVENT_CLICKED, (void *)i);
        d.nav_btn[i] = b;
    }
    set_page(0, false);
}

/* ------------------------------------------------------------------ detail */

static lv_obj_t *detail_row(lv_obj_t *parent, const char *title, lv_obj_t **value)
{
    lv_obj_t *r = cl_box(parent);
    lv_obj_set_width(r, LV_PCT(100));
    lv_obj_set_flex_flow(r, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(r, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    cl_label(r, &cl_font_14, CL_C_MUTED, title);
    *value = cl_label(r, &cl_font_14, CL_C_CREAM, "");
    lv_obj_set_style_text_align(*value, LV_TEXT_ALIGN_RIGHT, 0);
    lv_obj_set_width(*value, 170);
    cl_label_oneline(*value);
    return r;
}

static lv_obj_t *back_bar(lv_obj_t *scr, const char *title)
{
    lv_obj_t *bar = cl_box(scr);
    lv_obj_set_size(bar, SW, HEADER_H);
    lv_obj_set_flex_flow(bar, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(bar, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_hor(bar, 4, 0);
    lv_obj_t *b = lv_button_create(bar);
    lv_obj_remove_style_all(b);
    lv_obj_set_size(b, 84, 44);
    lv_obj_set_style_radius(b, 22, 0);
    lv_obj_set_style_bg_color(b, CL_HEX(CL_C_PANEL_HI), LV_STATE_PRESSED);
    lv_obj_set_style_bg_opa(b, LV_OPA_COVER, LV_STATE_PRESSED);
    lv_obj_t *l = cl_label(b, &cl_font_16, CL_C_CREAM_DIM, LV_SYMBOL_LEFT " Back");
    lv_obj_center(l);
    lv_obj_add_event_cb(b, back_to_dash, LV_EVENT_CLICKED, NULL);
    cl_label(bar, &cl_font_16, CL_C_CREAM, title);
    return bar;
}

static lv_obj_t *scroll_body(lv_obj_t *scr)
{
    lv_obj_t *body = lv_obj_create(scr);
    lv_obj_remove_style_all(body);
    lv_obj_set_pos(body, 0, HEADER_H);
    lv_obj_set_size(body, SW, SH - HEADER_H);
    lv_obj_set_style_pad_all(body, PAGE_PAD, 0);
    lv_obj_set_style_pad_row(body, 8, 0);
    lv_obj_set_flex_flow(body, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(body, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_scroll_dir(body, LV_DIR_VER);
    lv_obj_set_style_bg_color(body, CL_HEX(CL_C_CREAM), LV_PART_SCROLLBAR);
    lv_obj_set_style_bg_opa(body, LV_OPA_40, LV_PART_SCROLLBAR);
    lv_obj_set_style_width(body, 3, LV_PART_SCROLLBAR);
    return body;
}

static void detail_pin_clicked(lv_event_t *e)
{
    (void)e;
    if (det.id[0]) toggle_pin(det.id);
    refresh_detail();
}

static void build_detail(void)
{
    det.scr = cl_screen();
    back_bar(det.scr, "Session");
    lv_obj_t *body = scroll_body(det.scr);

    lv_obj_t *top = cl_card(body);
    lv_obj_set_size(top, CARD_W, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(top, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_flex_align(top, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_row(top, 6, 0);
    det.mascot = cl_mascot_create(top, 5);
    det.name = cl_label(top, &cl_font_20, CL_C_CREAM, "");
    lv_obj_set_width(det.name, CARD_W - 24);
    lv_label_set_long_mode(det.name, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_style_text_align(det.name, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_t *st = cl_box(top);
    lv_obj_set_flex_flow(st, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(st, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(st, 6, 0);
    det.chip = cl_chip(st, CL_C_SAGE, "");
    det.since = cl_label(st, &cl_font_12, CL_C_MUTED, "");
    det.gone = cl_label(top, &cl_font_12, CL_C_MUTED, "This session isn't in the latest update.");

    lv_obj_t *info = cl_card(body);
    lv_obj_set_size(info, CARD_W, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(info, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(info, 8, 0);
    lv_obj_t *hrow = cl_box(info);
    lv_obj_set_width(hrow, LV_PCT(100));
    lv_obj_set_flex_flow(hrow, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(hrow, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(hrow, 6, 0);
    det.helpers = cl_helpers_create(hrow, 6);
    det.helpers_lbl = cl_label(hrow, &cl_font_14, CL_C_CREAM, "");
    det.types = cl_label(info, &cl_font_12, CL_C_CREAM_DIM, "");
    lv_obj_set_width(det.types, CARD_W - 20);
    lv_label_set_long_mode(det.types, LV_LABEL_LONG_MODE_WRAP);

    lv_obj_t *ctx = cl_box(info);
    lv_obj_set_width(ctx, LV_PCT(100));
    lv_obj_set_flex_flow(ctx, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(ctx, 4, 0);
    lv_obj_t *ctop = cl_box(ctx);
    lv_obj_set_width(ctop, LV_PCT(100));
    lv_obj_set_flex_flow(ctop, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(ctop, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    cl_label(ctop, &cl_font_14, CL_C_MUTED, "Context window");
    det.ctx_lbl = cl_label(ctop, &cl_font_14, CL_C_CREAM, "");
    det.ctx_bar = cl_bar(ctx, CARD_W - 20, CL_C_TERRACOTTA);

    detail_row(info, "Total tokens", &det.tokens);
    detail_row(info, "Cache reads", &det.cache);
    detail_row(info, "Last activity", &det.activity);
    det.reason = cl_label(info, &cl_font_12, CL_C_MUTED, "");

    det.pin_btn = cl_button(body, "", CL_C_ROSE, detail_pin_clicked, NULL);
    lv_obj_set_width(det.pin_btn, CARD_W);
    det.pin_lbl = lv_obj_get_child(det.pin_btn, 0);
    lv_obj_t *note = cl_label(body, &cl_font_12, CL_C_MUTED,
                              "Pins are Claudette favourites only. They never change Claude Code itself.");
    lv_obj_set_width(note, CARD_W);
    lv_label_set_long_mode(note, LV_LABEL_LONG_MODE_WRAP);
}

static void refresh_detail(void)
{
    const cl_session_t *s = find_session(det.id);
    if (!s) {
        lv_obj_remove_flag(det.gone, LV_OBJ_FLAG_HIDDEN);
        cl_mascot_set_mood(det.mascot, CL_MOOD_UNKNOWN);
        return;
    }
    lv_obj_add_flag(det.gone, LV_OBJ_FLAG_HIDDEN);
    char buf[96];
    lv_label_set_text(det.name, s->name[0] ? s->name : "Untitled session");
    cl_chip_set(det.chip, cl_state_color(s->state), cl_state_label(s->state));
    fmt_since(buf, sizeof(buf), s);
    lv_label_set_text(det.since, buf);
    cl_mascot_set_mood(det.mascot, cl_mood_for_state(s->state));

    cl_helpers_set(det.helpers, s->agents_active);
    fmt_helpers(buf, sizeof(buf), s);
    char *dot = strstr(buf, " \xC2\xB7 ");
    if (dot) *dot = '\0';
    lv_label_set_text(det.helpers_lbl, buf);
    if (s->agent_type_count) {
        char types[CL_MAX_AGENT_TYPES * (CL_MAX_AGENT_TYPE + 4)] = "";
        size_t n = 0;
        for (uint8_t k = 0; k < s->agent_type_count; k++)
            n += (size_t)snprintf(types + n, sizeof(types) - n, "%s%s", k ? " \xC2\xB7 " : "", s->agent_types[k]);
        lv_label_set_text(det.types, types);
    } else {
        lv_label_set_text(det.types, s->agents_total > 0 ? "" : "");
    }

    char ctx_tok[16];
    cl_fmt_tokens(ctx_tok, sizeof(ctx_tok), s->context_tokens);
    if (s->context_pct >= 0) {
        lv_bar_set_value(det.ctx_bar, s->context_pct, LV_ANIM_OFF);
        if (s->context_tokens >= 0) lv_label_set_text_fmt(det.ctx_lbl, "%s \xC2\xB7 %d%% full", ctx_tok, s->context_pct);
        else lv_label_set_text_fmt(det.ctx_lbl, "%d%% full", s->context_pct);
        lv_obj_remove_flag(det.ctx_bar, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_label_set_text(det.ctx_lbl, s->context_tokens >= 0 ? ctx_tok : "Unavailable");
        lv_obj_add_flag(det.ctx_bar, LV_OBJ_FLAG_HIDDEN);
    }
    cl_fmt_tokens(buf, sizeof(buf), s->tokens);
    lv_label_set_text(det.tokens, buf);
    cl_fmt_tokens(buf, sizeof(buf), s->cache_read);
    lv_label_set_text(det.cache, buf);
    char age[16];
    cl_fmt_age(age, sizeof(age), live_age(s->last_activity_age_s));
    lv_label_set_text_fmt(det.activity, s->last_activity_age_s < 0 ? "%s" : "%s ago", age);
    lv_label_set_text(det.reason, s->background ? "Background session" : "Interactive session");
    lv_label_set_text(det.pin_lbl, s->pinned ? "Unpin from home" : "Pin to home");
}

static void open_detail(const char *id)
{
    snprintf(det.id, sizeof(det.id), "%s", id);
    cl_mascot_set_look(det.mascot, det.id);
    refresh_detail();
    lv_obj_scroll_to_y(lv_obj_get_child(det.scr, 1), 0, LV_ANIM_OFF);
    load(det.scr);
}

/* ------------------------------------------------------------------ settings */

static void brightness_changed(lv_event_t *e)
{
    dev.brightness = (uint8_t)lv_slider_get_value(lv_event_get_target_obj(e));
    if (plat.set_brightness) plat.set_brightness(dev.brightness, plat.user);
}

static void motion_changed(lv_event_t *e)
{
    dev.reduce_motion = lv_obj_has_state(lv_event_get_target_obj(e), LV_STATE_CHECKED);
    cl_mascot_set_reduce_motion(dev.reduce_motion);
    if (plat.set_reduce_motion) plat.set_reduce_motion(dev.reduce_motion, plat.user);
}

static void reconnect_clicked(lv_event_t *e)
{
    (void)e;
    if (plat.reconnect) plat.reconnect(plat.user);
    show_toast("Reconnecting\xE2\x80\xA6");
    load(d.scr);
}

static void forget_clicked(lv_event_t *e)
{
    (void)e;
    if (plat.forget_host) plat.forget_host(plat.user);
}

static void reset_clicked(lv_event_t *e)
{
    (void)e;
    if (!set.reset_armed) {
        set.reset_armed = true;
        lv_label_set_text(set.reset_lbl, "Tap again to erase everything");
        return;
    }
    set.reset_armed = false;
    lv_label_set_text(set.reset_lbl, "Factory reset");
    if (plat.factory_reset) plat.factory_reset(plat.user);
}

static const char *rotation_name(uint8_t q)
{
    static const char *names[4] = {"Portrait", "Landscape", "Portrait, upside down", "Landscape, flipped"};
    return names[q & 3];
}

static void rotate_clicked(lv_event_t *e)
{
    (void)e;
    apply_rotation((uint8_t)((rotation_q + 1) & 3), true);
}

static void refresh_settings(void)
{
    char buf[64];
    if (set.rot_lbl) lv_label_set_text(set.rot_lbl, rotation_name(rotation_q));
    lv_slider_set_value(set.slider, dev.brightness, LV_ANIM_OFF);
    if (dev.reduce_motion) lv_obj_add_state(set.motion, LV_STATE_CHECKED);
    else lv_obj_remove_state(set.motion, LV_STATE_CHECKED);
    if (dev.simulator) snprintf(buf, sizeof(buf), "Simulator");
    else if (dev.ssid[0]) snprintf(buf, sizeof(buf), "%s (%d dBm)", dev.ssid, dev.rssi);
    else snprintf(buf, sizeof(buf), "Not connected");
    lv_label_set_text(set.wifi, buf);
    lv_label_set_text(set.ip, dev.ip[0] ? dev.ip : "\xE2\x80\x94");
    lv_label_set_text(set.host, dev.host[0] ? dev.host : "Not paired");
    lv_label_set_text(set.fw, dev.fw);
    set.reset_armed = false;
    lv_label_set_text(set.reset_lbl, "Factory reset");
}

static void open_settings(lv_event_t *e)
{
    (void)e;
    refresh_settings();
    load(set.scr);
}

static void build_settings(void)
{
    set.scr = cl_screen();
    back_bar(set.scr, "Settings");
    lv_obj_t *body = scroll_body(set.scr);

    lv_obj_t *disp = cl_card(body);
    lv_obj_set_size(disp, CARD_W, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(disp, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(disp, 12, 0);
    cl_label(disp, &cl_font_14, CL_C_CREAM, "Brightness");
    set.slider = lv_slider_create(disp);
    lv_obj_set_width(set.slider, CARD_W - 40);
    lv_obj_align(set.slider, LV_ALIGN_CENTER, 0, 0);
    lv_slider_set_range(set.slider, 5, 100);
    lv_obj_set_style_bg_color(set.slider, CL_HEX(CL_C_LINE), LV_PART_MAIN);
    lv_obj_set_style_bg_color(set.slider, CL_HEX(CL_C_TERRACOTTA), LV_PART_INDICATOR);
    lv_obj_set_style_bg_color(set.slider, CL_HEX(CL_C_CREAM), LV_PART_KNOB);
    lv_obj_set_style_margin_hor(set.slider, 10, 0);
    lv_obj_add_event_cb(set.slider, brightness_changed, LV_EVENT_VALUE_CHANGED, NULL);

    lv_obj_t *mrow = cl_box(disp);
    lv_obj_set_width(mrow, LV_PCT(100));
    lv_obj_set_flex_flow(mrow, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(mrow, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    cl_label(mrow, &cl_font_14, CL_C_CREAM, "Reduce motion");
    set.motion = lv_switch_create(mrow);
    lv_obj_set_style_bg_color(set.motion, CL_HEX(CL_C_SAGE), LV_PART_INDICATOR | LV_STATE_CHECKED);
    lv_obj_add_event_cb(set.motion, motion_changed, LV_EVENT_VALUE_CHANGED, NULL);

    lv_obj_t *rrow = cl_box(disp);
    lv_obj_set_width(rrow, LV_PCT(100));
    lv_obj_set_flex_flow(rrow, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(rrow, LV_FLEX_ALIGN_SPACE_BETWEEN, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_t *rcol = cl_box(rrow);
    lv_obj_set_flex_flow(rcol, LV_FLEX_FLOW_COLUMN);
    cl_label(rcol, &cl_font_14, CL_C_CREAM, "Screen");
    set.rot_lbl = cl_label(rcol, &cl_font_12, CL_C_MUTED, "");
    lv_obj_t *rbtn = cl_button(rrow, LV_SYMBOL_REFRESH "  Rotate", CL_C_TERRACOTTA, rotate_clicked, NULL);
    lv_obj_set_height(rbtn, 40);

    lv_obj_t *info = cl_card(body);
    lv_obj_set_size(info, CARD_W, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(info, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(info, 8, 0);
    detail_row(info, "Wi-Fi", &set.wifi);
    detail_row(info, "Address", &set.ip);
    detail_row(info, "Watching", &set.host);
    detail_row(info, "Firmware", &set.fw);

    lv_obj_t *b1 = cl_button(body, LV_SYMBOL_REFRESH "  Reconnect", CL_C_SAGE, reconnect_clicked, NULL);
    lv_obj_set_width(b1, CARD_W);
    lv_obj_t *b2 = cl_button(body, "Pair with another Mac", CL_C_CREAM_DIM, forget_clicked, NULL);
    lv_obj_set_width(b2, CARD_W);
    lv_obj_t *b3 = cl_button(body, "Factory reset", CL_C_CORAL, reset_clicked, NULL);
    lv_obj_set_width(b3, CARD_W);
    set.reset_lbl = lv_obj_get_child(b3, 0);

    lv_obj_t *about = cl_label(body, &cl_font_12, CL_C_MUTED,
                               "Claudette is an unofficial, open-source companion for Claude Code. "
                               "Not affiliated with or endorsed by Anthropic.");
    lv_obj_set_width(about, CARD_W);
    lv_label_set_long_mode(about, LV_LABEL_LONG_MODE_WRAP);
}

/* ------------------------------------------------------------------ onboarding */

static lv_obj_t *onb_reset(cl_mood_t mood, const char *title, const char *body)
{
    if (!onb.scr) {
        onb.scr = cl_screen();
        onb.body = cl_box(onb.scr);
        lv_obj_set_size(onb.body, SW, SH);
        lv_obj_set_style_pad_all(onb.body, 16, 0);
        lv_obj_set_style_pad_row(onb.body, 10, 0);
        lv_obj_set_flex_flow(onb.body, LV_FLEX_FLOW_COLUMN);
        lv_obj_set_flex_align(onb.body, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
        lv_obj_add_flag(onb.body, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_set_scroll_dir(onb.body, LV_DIR_VER);
    }
    lv_obj_clean(onb.body);
    lv_obj_t *m = cl_mascot_create(onb.body, 5);
    cl_mascot_set_mood(m, mood);
    lv_obj_t *t = cl_label(onb.body, &cl_font_28, CL_C_CREAM, title);
    lv_obj_set_width(t, SW - 32);
    lv_label_set_long_mode(t, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_style_text_align(t, LV_TEXT_ALIGN_CENTER, 0);
    if (body && body[0]) {
        lv_obj_t *b = cl_label(onb.body, &cl_font_14, CL_C_CREAM_DIM, body);
        lv_obj_set_width(b, SW - 40);
        lv_label_set_long_mode(b, LV_LABEL_LONG_MODE_WRAP);
        lv_obj_set_style_text_align(b, LV_TEXT_ALIGN_CENTER, 0);
    }
    load(onb.scr);
    return onb.body;
}

void cl_ui_show_wifi_setup(const char *ap_name, const char *ap_password, const char *portal_url)
{
    if (onb_last.a != ap_name) {
        onb_last.kind = ONB_WIFI;
        snprintf(onb_last.a, sizeof(onb_last.a), "%s", ap_name ? ap_name : "");
        snprintf(onb_last.b, sizeof(onb_last.b), "%s", ap_password ? ap_password : "");
        snprintf(onb_last.c, sizeof(onb_last.c), "%s", portal_url ? portal_url : "");
    }
    lv_obj_t *b = onb_reset(CL_MOOD_HAPPY, "Hello! I'm Claudette",
                            "Let's get me on your Wi-Fi. Scan this with your phone, or join the network below.");
    lv_obj_t *card = cl_card(b);
    lv_obj_set_size(card, SW - 32, LV_SIZE_CONTENT);
    lv_obj_set_flex_flow(card, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(card, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_CENTER, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(card, 12, 0);

    char qr[128];
    snprintf(qr, sizeof(qr), "WIFI:T:WPA;S:%s;P:%s;;", ap_name ? ap_name : "", ap_password ? ap_password : "");
    lv_obj_t *q = lv_qrcode_create(card);
    lv_qrcode_set_size(q, 104);
    lv_qrcode_set_dark_color(q, CL_HEX(CL_C_BG));
    lv_qrcode_set_light_color(q, CL_HEX(CL_C_CREAM));
    lv_qrcode_update(q, qr, (uint32_t)strlen(qr));
    lv_obj_set_style_border_color(q, CL_HEX(CL_C_CREAM), 0);
    lv_obj_set_style_border_width(q, 4, 0);

    lv_obj_t *col = cl_box(card);
    lv_obj_set_flex_flow(col, LV_FLEX_FLOW_COLUMN);
    lv_obj_set_style_pad_row(col, 2, 0);
    cl_label(col, &cl_font_12, CL_C_MUTED, "Network");
    lv_obj_t *n = cl_label(col, &cl_font_16, CL_C_CREAM, ap_name);
    lv_obj_set_width(n, 140);
    lv_label_set_long_mode(n, LV_LABEL_LONG_MODE_WRAP);
    cl_label(col, &cl_font_12, CL_C_MUTED, "Password");
    lv_obj_t *p = cl_label(col, &cl_font_16, CL_C_TERRACOTTA, ap_password);
    lv_obj_set_width(p, 140);
    lv_label_set_long_mode(p, LV_LABEL_LONG_MODE_WRAP);

    char foot[96];
    snprintf(foot, sizeof(foot), "A setup page should pop up. If not, open %s", portal_url ? portal_url : "");
    lv_obj_t *f = cl_label(b, &cl_font_12, CL_C_MUTED, foot);
    lv_obj_set_width(f, SW - 40);
    lv_label_set_long_mode(f, LV_LABEL_LONG_MODE_WRAP);
    lv_obj_set_style_text_align(f, LV_TEXT_ALIGN_CENTER, 0);
}

static void show_progress(const char *title, const char *detail);

void cl_ui_show_progress(const char *title, const char *detail)
{
    if (onb_last.a != title) {
        onb_last.kind = ONB_PROGRESS;
        snprintf(onb_last.a, sizeof(onb_last.a), "%s", title ? title : "");
        snprintf(onb_last.b, sizeof(onb_last.b), "%s", detail ? detail : "");
    }
    show_progress(title, detail);
}

static void show_progress(const char *title, const char *detail)
{
    lv_obj_t *b = onb_reset(CL_MOOD_WORKING, title, detail);
    lv_obj_t *sp = lv_spinner_create(b);
    lv_obj_set_size(sp, 36, 36);
    lv_obj_set_style_arc_color(sp, CL_HEX(CL_C_LINE), LV_PART_MAIN);
    lv_obj_set_style_arc_color(sp, CL_HEX(CL_C_TERRACOTTA), LV_PART_INDICATOR);
    lv_obj_set_style_arc_width(sp, 4, LV_PART_MAIN);
    lv_obj_set_style_arc_width(sp, 4, LV_PART_INDICATOR);
}

static void host_clicked(lv_event_t *e)
{
    uint8_t idx = (uint8_t)(uintptr_t)lv_event_get_user_data(e);
    if (plat.select_host) plat.select_host(idx, plat.user);
}

void cl_ui_show_host_picker(const char *const *hosts, uint8_t count, const char *hint)
{
    if (onb_last.c != hint) {
        onb_last.kind = ONB_HOSTS;
        onb_last.host_count = count > 6 ? 6 : count;
        for (uint8_t i = 0; i < onb_last.host_count; i++)
            if (onb_last.hosts[i] != hosts[i]) snprintf(onb_last.hosts[i], sizeof(onb_last.hosts[i]), "%s", hosts[i]);
        snprintf(onb_last.c, sizeof(onb_last.c), "%s", hint ? hint : "");
    }
    if (count == 0) {
        show_progress("Looking for your Mac\xE2\x80\xA6",
                            hint && hint[0] ? hint : "Make sure the Claudette service is running on your Mac.");
        return;
    }
    lv_obj_t *b = onb_reset(CL_MOOD_HAPPY, count == 1 ? "Found your Mac!" : "Which Mac should I watch?",
                            count == 1 ? "Tap to start pairing." : "Tap the one you want me to keep an eye on.");
    for (uint8_t i = 0; i < count && i < 6; i++) {
        lv_obj_t *btn = cl_button(b, hosts[i], CL_C_TERRACOTTA, host_clicked, (void *)(uintptr_t)i);
        lv_obj_set_width(btn, SW - 40);
        lv_obj_set_height(btn, 52);
        lv_obj_set_style_text_font(lv_obj_get_child(btn, 0), &cl_font_16, 0);
    }
    if (hint && hint[0]) {
        lv_obj_t *h = cl_label(b, &cl_font_12, CL_C_MUTED, hint);
        lv_obj_set_width(h, SW - 40);
        lv_label_set_long_mode(h, LV_LABEL_LONG_MODE_WRAP);
        lv_obj_set_style_text_align(h, LV_TEXT_ALIGN_CENTER, 0);
    }
}

void cl_ui_show_pairing(const char *host_name, const char *code)
{
    if (onb_last.a != host_name) {
        onb_last.kind = ONB_PAIRING;
        snprintf(onb_last.a, sizeof(onb_last.a), "%s", host_name ? host_name : "");
        snprintf(onb_last.b, sizeof(onb_last.b), "%s", code ? code : "");
    }
    char body[128];
    snprintf(body, sizeof(body), "On %s, open localhost:3333 and type this code:", host_name ? host_name : "your Mac");
    lv_obj_t *b = onb_reset(CL_MOOD_NEEDS_YOU, "Let's pair up", body);
    char spaced[16];
    if (code && strlen(code) == 6) snprintf(spaced, sizeof(spaced), "%.3s %.3s", code, code + 3);
    else snprintf(spaced, sizeof(spaced), "%s", code ? code : "");
    lv_obj_t *card = cl_card(b);
    lv_obj_set_style_pad_hor(card, 24, 0);
    lv_obj_set_size(card, LV_SIZE_CONTENT, LV_SIZE_CONTENT);
    cl_label(card, &cl_font_44, CL_C_TERRACOTTA, spaced);
    cl_label(b, &cl_font_12, CL_C_MUTED, "The code expires in 5 minutes.");
}

static void onb_action(lv_event_t *e)
{
    (void)e;
    if (onb.action) onb.action(onb.action_user);
}

void cl_ui_show_message(const char *title, const char *body, const char *action_label,
                        void (*on_action)(void *user), void *user)
{
    if (onb_last.a != title) {
        onb_last.kind = ONB_MESSAGE;
        snprintf(onb_last.a, sizeof(onb_last.a), "%s", title ? title : "");
        snprintf(onb_last.b, sizeof(onb_last.b), "%s", body ? body : "");
        snprintf(onb_last.c, sizeof(onb_last.c), "%s", action_label ? action_label : "");
        onb_last.action = on_action;
        onb_last.user = user;
    }
    lv_obj_t *b = onb_reset(CL_MOOD_IDLE, title, body);
    onb.action = on_action;
    onb.action_user = user;
    if (action_label && action_label[0]) {
        lv_obj_t *btn = cl_button(b, action_label, CL_C_TERRACOTTA, onb_action, NULL);
        lv_obj_set_width(btn, SW - 80);
    }
}

/* ------------------------------------------------------------------ rotation */

/* Redo the whole UI for the new screen shape, keeping what you were looking at. */
static void rebuild_all(void)
{
    lv_obj_t *active = lv_screen_active();
    bool on_detail = active == det.scr, on_settings = active == set.scr;
    bool on_onb = onb.scr && active == onb.scr && onb_last.kind != ONB_NONE;
    char detail_id[CL_MAX_ID];
    snprintf(detail_id, sizeof(detail_id), "%s", det.id);
    uint8_t page = d.page;
    bool tiles = d.tiles_mode;
    lv_obj_t *old[] = {d.scr, det.scr, set.scr, onb.scr};

    compute_geometry();
    memset(&d, 0, sizeof(d));
    memset(&det, 0, sizeof(det));
    memset(&set, 0, sizeof(set));
    onb.scr = NULL;
    onb.body = NULL;
    build_dashboard();
    build_detail();
    build_settings();
    d.tiles_mode = tiles;
    lv_image_set_src(d.layout_icon, tiles ? &cl_spr_ico_list_x2 : &cl_spr_ico_grid_x2);
    lv_obj_align(toast, LV_ALIGN_BOTTOM_MID, RAIL_W / 2, -NAV_H - STRIP_H - 44);

    lv_screen_load(on_settings ? set.scr : d.scr);
    for (size_t i = 0; i < sizeof(old) / sizeof(old[0]); i++)
        if (old[i]) lv_obj_delete(old[i]);

    cl_ui_set_snapshot(&snap);
    set_page(page, false);
    lv_obj_scroll_to_x(d.pager, page * PAGE_W, LV_ANIM_OFF);
    if (on_settings) refresh_settings();
    if (on_detail && detail_id[0]) {
        snprintf(det.id, sizeof(det.id), "%s", detail_id);
        cl_mascot_set_look(det.mascot, det.id);
        refresh_detail();
        lv_screen_load(det.scr);
    }
    if (on_onb) {
        /* Replay the setup screen from copies (the public calls record what they're given). */
        char a[96], b[192], c[96], hs[6][48];
        memcpy(a, onb_last.a, sizeof(a));
        memcpy(b, onb_last.b, sizeof(b));
        memcpy(c, onb_last.c, sizeof(c));
        memcpy(hs, onb_last.hosts, sizeof(hs));
        const char *hp[6];
        for (int i = 0; i < 6; i++) hp[i] = hs[i];
        switch (onb_last.kind) {
        case ONB_WIFI: cl_ui_show_wifi_setup(a, b, c); break;
        case ONB_PROGRESS: cl_ui_show_progress(a, b); break;
        case ONB_HOSTS: cl_ui_show_host_picker(hp, onb_last.host_count, c); break;
        case ONB_PAIRING: cl_ui_show_pairing(a, b); break;
        case ONB_MESSAGE: cl_ui_show_message(a, b, c, onb_last.action, onb_last.user); break;
        default: break;
        }
    }
}

static void apply_rotation(uint8_t q, bool notify)
{
    q &= 3;
    if (q == rotation_q) return;
    rotation_q = q;
    lv_display_set_rotation(lv_display_get_default(), (lv_display_rotation_t)q);
    if (d.scr) rebuild_all(); /* before cl_ui_init() there's nothing to rebuild */
    if (notify && plat.set_rotation) plat.set_rotation(q, plat.user);
}

void cl_ui_set_rotation(uint8_t quarter_turns) { apply_rotation(quarter_turns, false); }

uint8_t *cl_ui_rotate_flush(lv_display_t *disp, const lv_area_t *area, uint8_t *px_map, uint8_t *rot_buf,
                            lv_area_t *out_area)
{
    *out_area = *area;
    lv_display_rotation_t rot = lv_display_get_rotation(disp);
    if (rot == LV_DISPLAY_ROTATION_0 || !rot_buf) return px_map;
    const int32_t w = lv_area_get_width(area);
    const int32_t h = lv_area_get_height(area);
    lv_display_rotate_area(disp, out_area);
    const uint32_t src_stride = lv_draw_buf_width_to_stride((uint32_t)w, LV_COLOR_FORMAT_RGB565);
    const uint32_t dst_stride =
        lv_draw_buf_width_to_stride((uint32_t)lv_area_get_width(out_area), LV_COLOR_FORMAT_RGB565);
    lv_draw_rotate(px_map, rot_buf, w, h, (int32_t)src_stride, (int32_t)dst_stride, rot, LV_COLOR_FORMAT_RGB565);
    return rot_buf;
}

/* ------------------------------------------------------------------ public */

void cl_ui_init(const cl_platform_t *platform)
{
    if (platform) plat = *platform;
    lv_display_t *disp = lv_display_get_default();
    lv_theme_t *th = lv_theme_default_init(disp, CL_HEX(CL_C_TERRACOTTA), CL_HEX(CL_C_SAGE), true, &cl_font_14);
    lv_display_set_theme(disp, th);

    compute_geometry();
    build_dashboard();
    build_detail();
    build_settings();

    toast = cl_box(lv_layer_top());
    lv_obj_set_style_bg_color(toast, CL_HEX(CL_C_CREAM), 0);
    lv_obj_set_style_bg_opa(toast, LV_OPA_COVER, 0);
    lv_obj_set_style_radius(toast, 16, 0);
    lv_obj_set_style_pad_hor(toast, 14, 0);
    lv_obj_set_style_pad_ver(toast, 7, 0);
    cl_label(toast, &cl_font_14, CL_C_BG, "");
    lv_obj_align(toast, LV_ALIGN_BOTTOM_MID, RAIL_W / 2, -NAV_H - STRIP_H - 44);
    lv_obj_add_flag(toast, LV_OBJ_FLAG_HIDDEN);
    toast_timer = lv_timer_create(toast_hide, 1600, NULL);
    lv_timer_pause(toast_timer);

    lv_timer_create(second_tick, 1000, NULL);
    snap_tick = link_tick = lv_tick_get();
    cl_ui_set_snapshot(&snap);
    update_header();
}

void cl_ui_show_dashboard(void)
{
    onb_last.kind = ONB_NONE;
    load(d.scr);
}

void cl_ui_set_snapshot(const cl_snapshot_t *s)
{
    if (s != &snap) {
        snap = *s;
        snap_tick = lv_tick_get();
    }
    update_home();
    update_agents();
    update_usage();
    update_header();
    if (lv_screen_active() == det.scr) refresh_detail();
}

void cl_ui_set_link(cl_link_t link, uint32_t last_ok_age_s)
{
    link_state = link;
    link_age_s = last_ok_age_s;
    link_tick = lv_tick_get();
    update_header();
}

void cl_ui_set_device_info(const cl_device_info_t *info)
{
    snprintf(dev.fw, sizeof(dev.fw), "%s", info->firmware_version ? info->firmware_version : "");
    snprintf(dev.ssid, sizeof(dev.ssid), "%s", info->wifi_ssid ? info->wifi_ssid : "");
    snprintf(dev.ip, sizeof(dev.ip), "%s", info->ip ? info->ip : "");
    snprintf(dev.host, sizeof(dev.host), "%s", info->host_label ? info->host_label : "");
    dev.rssi = info->rssi;
    dev.brightness = info->brightness;
    dev.simulator = info->is_simulator;
    if (d.tiles_mode != info->tiles) apply_layout(info->tiles);
    if ((info->rotation & 3) != rotation_q) apply_rotation(info->rotation, false);
    if (dev.reduce_motion != info->reduce_motion) {
        dev.reduce_motion = info->reduce_motion;
        cl_mascot_set_reduce_motion(dev.reduce_motion);
    }
    if (lv_screen_active() == set.scr) refresh_settings();
}
