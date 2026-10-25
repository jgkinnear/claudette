/**
 * mDNS / DNS-SD browsing for _claudette._tcp. Network task only.
 * Discovery is never trusted on its own: pairing still needs the on-screen code.
 */
#pragma once

#include <IPAddress.h>
#include <stdint.h>

struct DiscoveredHost {
    char name[41];   /* TXT name=, else instance name, else hostname */
    char addr[16];   /* dotted IPv4 */
    char mdns[64];   /* SRV target hostname, without ".local" */
    char id[33];     /* TXT id= (host id), "" if not advertised */
    uint16_t port;
};

/** Start the mDNS responder (idempotent). Call once the station has an IP. */
bool discovery_begin(const char *own_hostname);

/** Browse for ~3 s. Returns the number of IPv4-reachable hosts written to out. */
int discovery_query(DiscoveredHost *out, int max);

/** Resolve a hostname to IPv4: "name.local" via mDNS, dotted IPs directly,
 *  anything else via DNS. */
bool discovery_resolve(const char *host, IPAddress *out);
