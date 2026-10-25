/**
 * Wi-Fi onboarding: WPA2 soft-AP "Claudette-XXXX", captive DNS and a small
 * setup page (network list, password, optional manual Mac address + port).
 * Network task only.
 */
#pragma once

#include <stdbool.h>

/** Bring up the AP (WIFI_AP_STA) + DNS + web server. ap_name/password are copied. */
bool portal_start(const char *ap_name, const char *ap_password);

/** Serve DNS + HTTP; call every few ms. */
void portal_loop(void);

/** Tear down server, DNS and AP (leaves Wi-Fi in STA mode). */
void portal_stop(void);

/** True once the user saved settings (already written to NVS). */
bool portal_saved(void);

/** Number of phones/laptops currently joined to the AP. */
int portal_clients(void);
