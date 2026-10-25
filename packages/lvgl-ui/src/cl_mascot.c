#include "cl_mascot.h"

#include <stdio.h>
#include <string.h>

#include "cl_sprites.h"
#include "cl_theme.h"

/* Part of LVGL's image cache (lv_image_cache.h isn't in the public include set in 9.6).
 * We recolour sprites into our own buffers, so stale decoded copies must be dropped. */
void lv_image_cache_drop(const void *src);

/** A recoloured copy of one sprite, owned by a mascot. */
typedef struct {
    lv_image_dsc_t dsc;
    uint8_t *buf;
    const lv_image_dsc_t *from;
} layer_t;

typedef struct mascot {
    lv_obj_t *root;
    lv_obj_t *body;  /* face + headwear; bobs while working */
    lv_obj_t *face;
    lv_obj_t *hat;   /* bow / beanie / party hat / headphones */
    lv_obj_t *extra; /* glasses / freckles */
    lv_obj_t *prop;  /* tea cup beside her */
    lv_obj_t *badge; /* bubble, sparkle, zzz, question — top right */
    cl_look_t look;
    bool classic;
    uint8_t pal[6][4]; /* BGRA for palette slots CL_PAL_OUTLINE..CL_PAL_ACCENT_SHADE */
    layer_t face_l, hat_l, extra_l;
    uint8_t s;
    cl_mood_t mood;
    uint16_t blink_in;   /* ticks until next blink */
    uint8_t blink_left;  /* ticks the eyes stay closed */
    struct mascot *next;
} mascot_t;

typedef struct helpers {
    lv_obj_t *root;
    lv_obj_t *more;
    uint8_t max;
    int count;
    struct helpers *next;
} helpers_t;

static mascot_t *mascots;
static helpers_t *helper_rows;
static lv_timer_t *ticker;
static uint32_t tick_no;
static bool reduce_motion;

#define TICK_MS 100

/* ---------------------------------------------------------------- sprites */

static const lv_image_dsc_t *face_img(cl_mood_t mood, bool blink, uint8_t s)
{
#define PICK(name) (s == 2 ? &cl_spr_##name##_x2 : s == 3 ? &cl_spr_##name##_x3 : &cl_spr_##name##_x5)
    if (blink) return PICK(face_blink);
    switch (mood) {
    case CL_MOOD_NEEDS_YOU: return PICK(face_alert);
    case CL_MOOD_READY:
    case CL_MOOD_HAPPY: return PICK(face_happy);
    case CL_MOOD_ERROR: return PICK(face_dizzy);
    case CL_MOOD_STOPPED:
    case CL_MOOD_SLEEPING: return PICK(face_sleep);
    default: return PICK(face_idle);
    }
#undef PICK
}

#define ACC(name, s) ((s) == 2 ? &cl_spr_##name##_x2 : &cl_spr_##name##_x3)

static uint8_t scale_index(uint8_t s) { return s == 2 ? 0 : s == 3 ? 1 : 2; }

/* ---------------------------------------------------------------- looks */

const cl_look_t CL_LOOK_CLASSIC = {0, 0, 0, 0};

cl_look_t cl_look_for(const char *seed)
{
    /* FNV-1a over the UTF-8 bytes; mirrored by lookFor() in scripts/sprites.mjs. */
    uint32_t h = 0x811c9dc5u;
    for (const unsigned char *p = (const unsigned char *)seed; p && *p; p++) {
        h ^= *p;
        h *= 0x01000193u;
    }
    cl_look_t look;
    look.body = (uint8_t)(h % CL_LOOK_BODIES);
    look.headwear = (uint8_t)((h >> 3) % CL_LOOK_HEADWEAR);
    look.accent = (uint8_t)((h >> 5) % CL_LOOK_ACCENTS);
    if (cl_look_clashes[look.body] & (1u << look.accent)) look.accent = (uint8_t)((look.accent + 1) % CL_LOOK_ACCENTS);
    look.extra = (uint8_t)((h >> 7) % CL_LOOK_EXTRAS);
    return look;
}

static void put_bgra(uint8_t *dst, uint32_t rgb)
{
    dst[0] = rgb & 0xFF;
    dst[1] = (rgb >> 8) & 0xFF;
    dst[2] = (rgb >> 16) & 0xFF;
    dst[3] = 0xFF;
}

/* Show `src` on `img`, recoloured for this mascot's look (or as-is for the classic look). */
static void show_layer(mascot_t *m, lv_obj_t *img, layer_t *l, const lv_image_dsc_t *src)
{
    if (!src) {
        lv_obj_add_flag(img, LV_OBJ_FLAG_HIDDEN);
        return;
    }
    lv_obj_remove_flag(img, LV_OBJ_FLAG_HIDDEN);
    if (m->classic) {
        lv_image_set_src(img, src);
        return;
    }
    if (l->from == src) return;
    lv_image_cache_drop(&l->dsc);
    if (!l->buf || l->dsc.data_size < src->data_size) {
        lv_free(l->buf);
        l->buf = (uint8_t *)lv_malloc(src->data_size);
        if (!l->buf) {
            lv_image_set_src(img, src);
            return;
        }
    }
    memcpy(l->buf, src->data, src->data_size);
    memcpy(l->buf + CL_PAL_OUTLINE * 4, m->pal, sizeof(m->pal)); /* palette entries 1..6 */
    l->dsc = *src;
    l->dsc.data = l->buf;
    l->from = src;
    lv_image_set_src(img, &l->dsc);
}

static void set_face(mascot_t *m, bool blink);

void cl_mascot_set_look(lv_obj_t *obj, const char *seed)
{
    mascot_t *m = (mascot_t *)lv_obj_get_user_data(obj);
    if (!m) return;
    cl_look_t look = seed && seed[0] ? cl_look_for(seed) : CL_LOOK_CLASSIC;
    bool classic = memcmp(&look, &CL_LOOK_CLASSIC, sizeof(look)) == 0;
    if (classic == m->classic && memcmp(&look, &m->look, sizeof(look)) == 0) return;
    m->look = look;
    m->classic = classic;
    for (int i = 0; i < 4; i++) put_bgra(m->pal[i], cl_look_bodies[look.body][i]);
    for (int i = 0; i < 2; i++) put_bgra(m->pal[4 + i], cl_look_accents[look.accent][i]);
    m->face_l.from = m->hat_l.from = m->extra_l.from = NULL; /* force a re-copy */
    uint8_t si = scale_index(m->s);
    show_layer(m, m->hat, &m->hat_l, cl_look_headwear[look.headwear][si]);
    show_layer(m, m->extra, &m->extra_l, cl_look_extras[look.extra][si]);
    set_face(m, m->blink_left > 0);
}

cl_mood_t cl_mood_for_state(cl_state_t st)
{
    switch (st) {
    case CL_STATE_WORKING: return CL_MOOD_WORKING;
    case CL_STATE_NEEDS_ATTENTION: return CL_MOOD_NEEDS_YOU;
    case CL_STATE_READY: return CL_MOOD_READY;
    case CL_STATE_FAILED: return CL_MOOD_ERROR;
    case CL_STATE_STOPPED: return CL_MOOD_STOPPED;
    default: return CL_MOOD_UNKNOWN;
    }
}

/* ---------------------------------------------------------------- motion */

static void translate_y_cb(void *obj, int32_t v) { lv_obj_set_style_translate_y((lv_obj_t *)obj, v, 0); }

static void start_bob(lv_obj_t *obj, int32_t amp, uint32_t ms, uint32_t pause)
{
    lv_anim_delete(obj, translate_y_cb);
    lv_obj_set_style_translate_y(obj, 0, 0);
    if (reduce_motion || amp == 0) return;
    lv_anim_t a;
    lv_anim_init(&a);
    lv_anim_set_var(&a, obj);
    lv_anim_set_exec_cb(&a, translate_y_cb);
    lv_anim_set_values(&a, 0, -amp);
    lv_anim_set_duration(&a, ms);
    lv_anim_set_reverse_duration(&a, ms);
    lv_anim_set_repeat_delay(&a, pause);
    lv_anim_set_repeat_count(&a, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_path_cb(&a, lv_anim_path_ease_in_out);
    lv_anim_start(&a);
}

static void set_face(mascot_t *m, bool blink) { show_layer(m, m->face, &m->face_l, face_img(m->mood, blink, m->s)); }

static void apply_mood(mascot_t *m)
{
    uint8_t s = m->s;
    uint8_t as = s == 2 ? 2 : 3; /* accessory scale */
    set_face(m, m->blink_left > 0);

    /* prop: a cup of tea when the work is done */
    const void *prop = NULL;
    int32_t px = 0, py = 0;
    if (m->mood == CL_MOOD_READY || m->mood == CL_MOOD_HAPPY) {
        prop = ACC(tea, as);
        px = 14 * s;
        py = 18 * s - 8 * as;
    }
    if (prop) {
        lv_image_set_src(m->prop, prop);
        lv_obj_set_pos(m->prop, px, py);
        lv_obj_remove_flag(m->prop, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(m->prop, LV_OBJ_FLAG_HIDDEN);
    }

    const void *badge = NULL;
    switch (m->mood) {
    case CL_MOOD_WORKING: badge = ACC(sparkle1, as); break;
    case CL_MOOD_NEEDS_YOU: badge = ACC(bang, as); break;
    case CL_MOOD_SLEEPING:
    case CL_MOOD_STOPPED: badge = ACC(zzz, as); break;
    case CL_MOOD_UNKNOWN: badge = ACC(question, as); break;
    case CL_MOOD_HAPPY: badge = ACC(heart, as); break;
    default: break;
    }
    if (badge) {
        lv_image_set_src(m->badge, badge);
        lv_obj_set_pos(m->badge, 22 * s - (int32_t)((const lv_image_dsc_t *)badge)->header.w, 0);
        lv_obj_remove_flag(m->badge, LV_OBJ_FLAG_HIDDEN);
    } else {
        lv_obj_add_flag(m->badge, LV_OBJ_FLAG_HIDDEN);
    }

    start_bob(m->body, m->mood == CL_MOOD_WORKING ? s : 0, 420, 80);
    start_bob(m->badge, m->mood == CL_MOOD_NEEDS_YOU ? s * 2 : (m->mood == CL_MOOD_SLEEPING ? s : 0),
              m->mood == CL_MOOD_NEEDS_YOU ? 260 : 1400, m->mood == CL_MOOD_NEEDS_YOU ? 900 : 200);
}

static void tick_cb(lv_timer_t *t)
{
    (void)t;
    tick_no++;
    if (reduce_motion) return;
    for (mascot_t *m = mascots; m; m = m->next) {
        if (m->mood == CL_MOOD_WORKING && tick_no % 4 == 0) {
            uint8_t as = m->s == 2 ? 2 : 3;
            bool alt = (tick_no / 4) % 2;
            lv_image_set_src(m->badge, alt ? ACC(sparkle2, as) : ACC(sparkle1, as));
        }
        bool can_blink = m->mood == CL_MOOD_IDLE || m->mood == CL_MOOD_WORKING || m->mood == CL_MOOD_UNKNOWN ||
                         m->mood == CL_MOOD_NEEDS_YOU;
        if (m->blink_left > 0) {
            if (--m->blink_left == 0) set_face(m, false);
        } else if (can_blink && m->blink_in-- == 0) {
            m->blink_left = 2;
            m->blink_in = (uint16_t)(25 + lv_rand(0, 40));
            set_face(m, true);
        }
    }
    if (tick_no % 3 == 0) {
        for (helpers_t *h = helper_rows; h; h = h->next) {
            uint32_t n = lv_obj_get_child_count(h->root);
            for (uint32_t i = 0; i + 1 < n; i++) { /* last child is the "+N" label */
                lv_obj_t *img = lv_obj_get_child(h->root, (int32_t)i);
                bool hop = ((tick_no / 3) + i) % 2;
                lv_image_set_src(img, hop ? &cl_spr_helper_hop_x2 : &cl_spr_helper_x2);
            }
        }
    }
}

static void ensure_ticker(void)
{
    if (!ticker) ticker = lv_timer_create(tick_cb, TICK_MS, NULL);
}

void cl_mascot_set_reduce_motion(bool reduce)
{
    reduce_motion = reduce;
    for (mascot_t *m = mascots; m; m = m->next) {
        m->blink_left = 0;
        apply_mood(m);
    }
    for (helpers_t *h = helper_rows; h; h = h->next) {
        uint32_t n = lv_obj_get_child_count(h->root);
        for (uint32_t i = 0; i + 1 < n; i++) lv_image_set_src(lv_obj_get_child(h->root, (int32_t)i), &cl_spr_helper_x2);
    }
}

/* ---------------------------------------------------------------- mascot */

static void mascot_deleted(lv_event_t *e)
{
    mascot_t *m = (mascot_t *)lv_event_get_user_data(e);
    lv_anim_delete(m->body, translate_y_cb);
    lv_anim_delete(m->badge, translate_y_cb);
    layer_t *layers[] = {&m->face_l, &m->hat_l, &m->extra_l};
    for (int i = 0; i < 3; i++) {
        if (!layers[i]->buf) continue;
        lv_image_cache_drop(&layers[i]->dsc);
        lv_free(layers[i]->buf);
    }
    for (mascot_t **pp = &mascots; *pp; pp = &(*pp)->next) {
        if (*pp == m) {
            *pp = m->next;
            break;
        }
    }
    lv_free(m);
}

static lv_obj_t *image(lv_obj_t *parent)
{
    lv_obj_t *img = lv_image_create(parent);
    lv_obj_remove_flag(img, LV_OBJ_FLAG_CLICKABLE);
    return img;
}

lv_obj_t *cl_mascot_create(lv_obj_t *parent, uint8_t scale)
{
    ensure_ticker();
    if (scale != 2 && scale != 3) scale = 5;
    mascot_t *m = (mascot_t *)lv_malloc_zeroed(sizeof(mascot_t));
    m->s = scale;
    m->mood = CL_MOOD_IDLE;
    m->blink_in = (uint16_t)lv_rand(10, 50);

    m->root = cl_box(parent);
    lv_obj_set_size(m->root, 22 * scale, 18 * scale);
    lv_obj_remove_flag(m->root, LV_OBJ_FLAG_CLICKABLE);
    m->body = cl_box(m->root);
    lv_obj_set_size(m->body, 16 * scale, 16 * scale);
    lv_obj_set_pos(m->body, 0, 2 * scale);
    m->face = image(m->body);
    m->hat = image(m->body);
    m->extra = image(m->body);
    m->prop = image(m->root);
    m->badge = image(m->root);
    lv_obj_set_user_data(m->root, m);
    lv_obj_add_event_cb(m->root, mascot_deleted, LV_EVENT_DELETE, m);

    m->next = mascots;
    mascots = m;
    m->classic = true;
    m->look = CL_LOOK_CLASSIC;
    uint8_t si = scale_index(scale);
    show_layer(m, m->hat, &m->hat_l, cl_look_headwear[0][si]);
    show_layer(m, m->extra, &m->extra_l, NULL);
    apply_mood(m);
    return m->root;
}

void cl_mascot_set_mood(lv_obj_t *obj, cl_mood_t mood)
{
    mascot_t *m = (mascot_t *)lv_obj_get_user_data(obj);
    if (!m || m->mood == mood) return;
    m->mood = mood;
    m->blink_left = 0;
    apply_mood(m);
}

/* ---------------------------------------------------------------- helpers */

static void helpers_deleted(lv_event_t *e)
{
    helpers_t *h = (helpers_t *)lv_event_get_user_data(e);
    for (helpers_t **pp = &helper_rows; *pp; pp = &(*pp)->next) {
        if (*pp == h) {
            *pp = h->next;
            break;
        }
    }
    lv_free(h);
}

lv_obj_t *cl_helpers_create(lv_obj_t *parent, uint8_t max_shown)
{
    ensure_ticker();
    helpers_t *h = (helpers_t *)lv_malloc_zeroed(sizeof(helpers_t));
    h->max = max_shown;
    h->count = -2;
    h->root = cl_box(parent);
    lv_obj_set_flex_flow(h->root, LV_FLEX_FLOW_ROW);
    lv_obj_set_flex_align(h->root, LV_FLEX_ALIGN_START, LV_FLEX_ALIGN_END, LV_FLEX_ALIGN_CENTER);
    lv_obj_set_style_pad_column(h->root, 1, 0);
    lv_obj_remove_flag(h->root, LV_OBJ_FLAG_CLICKABLE);
    h->more = cl_label(h->root, &cl_font_12, CL_C_SAGE, "");
    lv_obj_set_user_data(h->root, h);
    lv_obj_add_event_cb(h->root, helpers_deleted, LV_EVENT_DELETE, h);
    h->next = helper_rows;
    helper_rows = h;
    return h->root;
}

void cl_helpers_set(lv_obj_t *obj, int count)
{
    helpers_t *h = (helpers_t *)lv_obj_get_user_data(obj);
    if (!h || h->count == count) return;
    h->count = count;
    if (count <= 0) {
        lv_obj_add_flag(h->root, LV_OBJ_FLAG_HIDDEN);
        return;
    }
    lv_obj_remove_flag(h->root, LV_OBJ_FLAG_HIDDEN);
    int shown = count > h->max ? h->max : count;
    int have = (int)lv_obj_get_child_count(h->root) - 1;
    while (have < shown) {
        lv_obj_t *img = image(h->root);
        lv_image_set_src(img, &cl_spr_helper_x2);
        lv_obj_move_to_index(img, have);
        have++;
    }
    while (have > shown) {
        lv_obj_delete(lv_obj_get_child(h->root, have - 1));
        have--;
    }
    if (count > shown) lv_label_set_text_fmt(h->more, "+%d", count - shown);
    else lv_label_set_text(h->more, "");
}
