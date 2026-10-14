#ifndef CODEX_TAILSCALE_FORWARD_H
#define CODEX_TAILSCALE_FORWARD_H
// Shares an existing tailscale handle; never creates another node or identity.
void *codex_forward_start(int node, unsigned short port);
void codex_forward_stop(void *forward);
#endif
