/**
 * Optional developer shortcuts. Copy to include/secrets.h (gitignored) to skip
 * the setup portal while hacking. Values are only used when nothing has been
 * saved on the device yet; the setup portal and factory reset still win.
 *
 * Never commit secrets.h. Release builds should not have one.
 */
#pragma once

#define DEV_WIFI_SSID "MyNetwork"
#define DEV_WIFI_PASSWORD "my-wifi-password"

/* Optional: skip mDNS discovery and talk to this host directly. */
// #define DEV_HOST_ADDR "192.168.1.20"
// #define DEV_HOST_PORT 3333
