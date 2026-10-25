/**
 * The network task: Wi-Fi, setup portal, discovery, pairing and polling.
 * Runs on core 0 and never calls LVGL; it talks to the UI through bridge.h.
 */
#pragma once

void net_task_start(void);

/** Short name of the current state, for the serial "status" command. */
const char *net_state_name(void);
