/**
 * Persistent settings in NVS (namespace "claudette").
 *
 * Ownership: Wi-Fi, host, device id and token are read/written by the network
 * task only (after boot); brightness and reduce-motion by the UI task only.
 * Each save takes an internal mutex, so the two never interleave in NVS.
 */
#pragma once

#include <stdint.h>

struct HostConfig {
    char name[41];   /* display name, e.g. "Studio MacBook" */
    char addr[64];   /* IPv4 address or hostname used for requests */
    char mdns[64];   /* mDNS hostname (without .local) for re-resolving, "" if unknown */
    char id[33];     /* host id from pairing / TXT id=, "" if unknown */
    uint16_t port;
    bool manual;     /* entered in the setup portal: never auto-rediscovered */
};

struct Settings {
    char ssid[33];
    char pass[65];
    HostConfig host;
    char device_id[41];
    char token[96];
    uint8_t brightness;  /* 5..100 */
    bool reduce_motion;
    bool tiles; /* home layout: tile grid */
    uint8_t rotation; /* quarter turns, 0..3 */
};

extern Settings g_settings;

void settings_load(void);

void settings_save_wifi(void);
void settings_save_host(void);
void settings_save_token(void);
void settings_save_device_id(void);
void settings_save_display(void);

/** Drop the device token. With forget_host, also drop the remembered host
 *  (including a manually entered one). */
void settings_clear_pairing(bool forget_host);

/** Erase everything in our namespace (Wi-Fi, host, token, prefs). */
void settings_factory_reset(void);

bool settings_has_wifi(void);
bool settings_has_host(void);
bool settings_has_token(void);

/** Make sure device_id exists (random, generated once, persisted). */
void settings_ensure_device_id(void);
