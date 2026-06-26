/**
 * Default value pre-filled into the "API server URL" field on the login screen.
 * Points at a DuckDNS hostname whose A record resolves to the LAN IP of the
 * machine running the API (not a public address) - this lets every client,
 * including mobile, use a real Let's Encrypt certificate instead of a
 * self-signed one that needs manual OS trust-store installation.
 */
export const DEFAULT_API_BASE_URL = "https://ayran-lan-streamer.duckdns.org:9443";
