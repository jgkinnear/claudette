/** Claudette the mascot, and her little helpers (one per running subagent). */
#ifndef CL_MASCOT_H
#define CL_MASCOT_H

#include "cl_model.h"
#include "lvgl.h"

typedef enum {
    CL_MOOD_IDLE = 0,
    CL_MOOD_WORKING,
    CL_MOOD_NEEDS_YOU,
    CL_MOOD_READY,
    CL_MOOD_ERROR,
    CL_MOOD_STOPPED,
    CL_MOOD_UNKNOWN,
    CL_MOOD_SLEEPING,
    CL_MOOD_HAPPY,
} cl_mood_t;

cl_mood_t cl_mood_for_state(cl_state_t s);

/** Each session gets its own Claudette: body colour, headwear, accent colour and an optional extra. */
typedef struct {
    uint8_t body, headwear, accent, extra;
} cl_look_t;

/** The classic terracotta Claudette with a pink bow. */
extern const cl_look_t CL_LOOK_CLASSIC;

/** Deterministic look for a seed (the session's opaque id). Matches lookFor() in scripts/sprites.mjs. */
cl_look_t cl_look_for(const char *seed);

/** scale: 2 (32 px), 3 (48 px) or 5 (80 px). The widget is 22*scale × 18*scale. */
lv_obj_t *cl_mascot_create(lv_obj_t *parent, uint8_t scale);
void cl_mascot_set_mood(lv_obj_t *mascot, cl_mood_t mood);
/** Dress the mascot for a session. NULL or "" gives the classic look. */
void cl_mascot_set_look(lv_obj_t *mascot, const char *seed);

/** A row of up to `max_shown` helpers plus "+N". count < 0 hides the row. */
lv_obj_t *cl_helpers_create(lv_obj_t *parent, uint8_t max_shown);
void cl_helpers_set(lv_obj_t *helpers, int count);

/** Global: stop bobbing/hopping/blinking for reduced motion. */
void cl_mascot_set_reduce_motion(bool reduce);

#endif /* CL_MASCOT_H */
