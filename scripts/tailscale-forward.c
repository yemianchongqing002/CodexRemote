#include "tailscale-forward.h"
#include "tailscale.h"
#include <arpa/inet.h>
#include <errno.h>
#include <poll.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

typedef struct {int node,listener;unsigned short port;pthread_t thread;atomic_int stop,active;char path[4096];} forward;
typedef struct {forward *owner;int incoming;char local[128],remote[128];} stream;
static int send_all(int fd,const char *p,size_t n){while(n){ssize_t k=send(fd,p,n,0);if(k<0&&errno==EINTR)continue;if(k<=0)return -1;p+=k;n-=k;}return 0;}
static void *relay(void *arg){
 stream *s=arg;forward *f=s->owner;int out=-1;FILE *file=NULL;
 if(atomic_load(&f->stop))goto done;
 // The running service publishes this private descriptor only for wildcard listening.
 file=fopen(f->path,"r");if(!file)goto done;
 unsigned port=0;char secret[65]={0};int fields=fscanf(file,"%u %64s",&port,secret);fclose(file);file=NULL;
 if(fields!=2||port==0||port>65535||strlen(secret)!=64)goto done;
 out=socket(AF_INET,SOCK_STREAM,0);if(out<0)goto done;
 int one=1;setsockopt(out,SOL_SOCKET,SO_NOSIGPIPE,&one,sizeof(one));setsockopt(s->incoming,SOL_SOCKET,SO_NOSIGPIPE,&one,sizeof(one));
 struct timeval timeout={3,0};setsockopt(out,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));setsockopt(out,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout));
 setsockopt(s->incoming,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout));
 struct sockaddr_in addr={.sin_family=AF_INET,.sin_port=htons(port),.sin_addr.s_addr=htonl(INADDR_LOOPBACK)};
 if(connect(out,(struct sockaddr*)&addr,sizeof(addr)))goto done;
 char header[512];int len=snprintf(header,sizeof(header),"CRNET1 %s %s %s\n",secret,s->local,s->remote);
 memset(secret,0,sizeof(secret));if(send_all(out,header,len))goto done;memset(header,0,sizeof(header));
 char ack[3];size_t got=0;while(got<3){ssize_t n=recv(out,ack+got,3-got,0);if(n<=0)goto done;got+=n;}if(memcmp(ack,"OK\n",3))goto done;
 struct pollfd pipes[2]={{s->incoming,POLLIN,0},{out,POLLIN,0}};int open_read=2;
 while(open_read&&!atomic_load(&f->stop)){
  int result=poll(pipes,2,1000);if(result<0){if(errno==EINTR)continue;break;}if(!result)continue;
  for(int i=0;i<2;i++){if(pipes[i].fd<0||!pipes[i].revents)continue;char buf[32768];ssize_t n=recv(pipes[i].fd,buf,sizeof(buf),0);
   int peer=i==0?out:s->incoming;
   if(n==0){shutdown(peer,SHUT_WR);pipes[i].fd=-1;open_read--;}
   else if(n<0||send_all(peer,buf,n))goto done;
  }
 }
 done:if(file)fclose(file);if(out>=0)close(out);close(s->incoming);atomic_fetch_sub(&f->active,1);free(s);return NULL;
}
static void *accept_loop(void *arg){
 forward *f=arg;
 while(!atomic_load(&f->stop)){
  struct pollfd p={f->listener,POLLIN,0};int r=poll(&p,1,1000);if(r<=0)continue;
  int incoming=-1;if(tailscale_accept(f->listener,&incoming))break;
  if(atomic_load(&f->active)>=64){close(incoming);continue;}
  stream *s=calloc(1,sizeof(*s));if(!s){close(incoming);continue;}s->owner=f;s->incoming=incoming;
  if(tailscale_getips(f->node,s->local,sizeof(s->local))||tailscale_getremoteaddr(f->listener,incoming,s->remote,sizeof(s->remote))){close(incoming);free(s);continue;}
  // libtailscale returns IPv6 in brackets and IPv4 without a port.
  if(s->remote[0]=='['){size_t n=strlen(s->remote);if(n<3||s->remote[n-1]!=']'){close(incoming);free(s);continue;}s->remote[n-1]=0;memmove(s->remote,s->remote+1,n-1);}
  atomic_fetch_add(&f->active,1);pthread_t thread;
  if(pthread_create(&thread,NULL,relay,s)){atomic_fetch_sub(&f->active,1);close(incoming);free(s);}else pthread_detach(thread);
 }
 return NULL;
}
void *codex_forward_start(int node,unsigned short port){
 const char *home=getenv("HOME");if(!home||!port)return NULL;
 forward *f=calloc(1,sizeof(*f));if(!f)return NULL;f->node=node;f->port=port;
 if(snprintf(f->path,sizeof(f->path),"%s/.config/codex-remote/network/%u.bridge",home,port)>=(int)sizeof(f->path)){free(f);return NULL;}
 char address[32];snprintf(address,sizeof(address),":%u",port);
 if(tailscale_listen(node,"tcp",address,&f->listener)){free(f);return NULL;}
 if(pthread_create(&f->thread,NULL,accept_loop,f)){close(f->listener);free(f);return NULL;}return f;
}
void codex_forward_stop(void *ptr){
 forward *f=ptr;if(!f)return;atomic_store(&f->stop,1);shutdown(f->listener,SHUT_RDWR);pthread_join(f->thread,NULL);close(f->listener);
 while(atomic_load(&f->active))usleep(10000);free(f);
}
