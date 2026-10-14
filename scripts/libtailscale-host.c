// Private child-process bridge for the web preview. Credentials only travel on stdout's pipe.
#include "tailscale.h"
#include "tailscale-forward.h"
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
int main(int argc, char **argv) {
  if(argc != 3) return 2;
  umask(0077);
  tailscale s=tailscale_new();
  if(s<0) return 3;
  if(tailscale_set_dir(s,argv[1]) || tailscale_set_hostname(s,argv[2]) || tailscale_set_logfd(s,-1)) return 4;
  char address[256],proxy[33],api[33];
  if(tailscale_loopback(s,address,sizeof(address),proxy,api)) { tailscale_close(s); return 5; }
  void *forward=codex_forward_start(s,8787);
  if(!forward){tailscale_close(s);return 6;}
  printf("{\"address\":\"%s\",\"proxy\":\"%s\",\"api\":\"%s\"}\n",address,proxy,api);fflush(stdout);
  // Parent lifetime owns the embedded node. EOF also handles unexpected parent exits.
  while(getchar()!=EOF) {}
  codex_forward_stop(forward);
  tailscale_close(s);
  return 0;
}
