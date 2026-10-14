package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"codexremote/internal/chat"
	"codexremote/internal/delivery"
	"codexremote/internal/desktop"
	"codexremote/internal/localtls"
	"codexremote/internal/networkbridge"
	"codexremote/internal/platform"
	"codexremote/internal/server"
	"codexremote/internal/supervisor"
)

func main() {
	home, _ := os.UserHomeDir()
	codexHome := os.Getenv("CODEX_HOME")
	if codexHome == "" {
		codexHome = filepath.Join(home, ".codex")
	}
	appManaged := flag.Bool("app-managed", false, "由客户端管理生命周期：仅本机监听，父进程关闭输入管道后退出")
	readyFile := flag.String("ready-file", "", "客户端私有就绪文件，仅用于 app-managed 模式")
	enableSSH := flag.Bool("enable-ssh", false, "仅 Windows：通过 UAC 管理员确认后安装并开启 SSH，然后退出")
	listen := flag.String("listen", ":8787", "监听地址；默认全部系统接口及内嵌网络")
	useTLS := flag.Bool("tls", true, "自动生成本地证书并启用 HTTPS；旧版 HTTP 部署可显式设为 false")
	data := flag.String("codex-home", codexHome, "Codex 数据目录，只读")
	tokenFile := flag.String("token-file", filepath.Join(home, ".config", "codex-remote", "token"), "访问口令文件（首次自动生成）")
	requireToken := flag.Bool("require-token", false, "启用访问口令；默认内网免口令")
	hosts := flag.String("allow-host", "", "额外允许的 Host，不含协议和端口，逗号分隔")
	interval := flag.Duration("interval", 3*time.Second, "有前台查看器时的日志检查间隔，最小 1s")
	diagnose := flag.Bool("diagnose", false, "只读检查日志兼容性，输出数量后退出")
	enableSend := flag.Bool("enable-send", true, "允许网页发送（默认开启；可用 --read-only 关闭）")
	readOnly := flag.Bool("read-only", false, "仅查看，禁用网页发送、排队和新建会话；优先于 --enable-send")
	ipcSocket := flag.String("ipc-socket", "", "桌面 IPC 地址；Windows 请显式指定本机命名管道")
	openCreated := flag.Bool("open-created-in-desktop", true, "创建后在本机桌面打开并开始首条消息")
	openOnSend := flag.Bool("open-thread-on-send", true, "发送前找不到接收方时，在桌面打开该聊天并重新确认")
	creatorBinary := flag.String("codex-binary", platform.CodexBinary(), "新建会话使用的本机 Codex 可执行文件")
	probe := flag.String("probe-thread", "", "只读探测指定聊天的桌面接收方后退出")
	supervise := flag.Bool("supervise", false, "先启动 B，再由 B 启动直接监听客户端的 A，双方健康守护")
	guardianConfig := flag.String("guardian-config", "", "守护配置文件；默认在口令文件旁")
	guardianRole := flag.String("guardian-role", "", "内部角色 A 或 B")
	guardianSession := flag.String("guardian-session", "", "内部守护会话标识")
	guardianAction := flag.String("guardian-action", "", "本机守护操作：stop、check、repair")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if flag.NArg() != 0 {
		log.Fatal("不支持位置参数")
	}
	if *appManaged {
		host, _, e := net.SplitHostPort(*listen)
		if e != nil || host != "127.0.0.1" || !*requireToken || *supervise || *guardianRole != "" || *guardianAction != "" || *readyFile == "" {
			log.Fatal("app-managed 必须使用 127.0.0.1、访问口令和就绪文件，且不能与守护模式一起运行")
		}
		// The client owns this pipe. EOF also handles an unexpected client crash.
		go func() { _, _ = io.Copy(io.Discard, os.Stdin); stop() }()
	} else if *readyFile != "" {
		log.Fatal("ready-file 仅用于 app-managed 模式")
	}
	if *enableSSH {
		flag.Visit(func(f *flag.Flag) {
			if f.Name != "enable-ssh" {
				log.Fatal("--enable-ssh 必须单独使用，不启动服务或守护进程")
			}
		})
		if err := platform.EnableSSH(ctx); err != nil {
			log.Fatal(err)
		}
		return
	}
	if *guardianConfig == "" {
		*guardianConfig = *tokenFile + ".supervisor.json"
	}
	var err error
	*guardianConfig, err = filepath.Abs(*guardianConfig)
	if err != nil {
		log.Fatal(err)
	}
	if *guardianAction != "" {
		stopCtx, cancel := context.WithTimeout(ctx, 180*time.Second)
		defer cancel()
		switch *guardianAction {
		case "stop":
			err = supervisor.Stop(stopCtx, *guardianConfig)
		case "check":
			err = supervisor.Check(stopCtx, *guardianConfig)
		case "repair":
			err = supervisor.Repair(stopCtx, *guardianConfig)
		default:
			log.Fatal("无效守护操作")
		}
		if errors.Is(err, supervisor.ErrStopped) {
			os.Exit(2)
		}
		if err != nil {
			log.Fatal(err)
		}
		if *guardianAction == "stop" {
			fmt.Println("A、B 已停止")
		}
		return
	}
	var peer *supervisor.Peer
	if *guardianRole != "" {
		flag.Visit(func(f *flag.Flag) {
			if f.Name != "guardian-role" && f.Name != "guardian-config" && f.Name != "guardian-session" {
				log.Fatal("内部角色只能从配置文件读取业务参数")
			}
		})
		if *guardianRole == "B" {
			if err = supervisor.RunGuardian(ctx, *guardianConfig, *guardianSession); err != nil {
				log.Fatal(err)
			}
			return
		}
		if *guardianRole != "A" {
			log.Fatal("无效守护角色")
		}
		peer, err = supervisor.Join(ctx, *guardianConfig, "A", *guardianSession)
		if err != nil {
			log.Fatal(err)
		}
		peer.StartMonitor()
		defer peer.Close()
		ctx = peer.Context()
		cfg, e := supervisor.Load(*guardianConfig)
		if e != nil {
			log.Fatal(e)
		}
		s := cfg.Service
		*listen, *data, *tokenFile, *hosts = s.Listen, s.Home, s.TokenFile, s.AllowHost
		*requireToken = s.RequireToken
		*useTLS = s.TLS
		*interval, e = time.ParseDuration(s.Interval)
		if e != nil {
			log.Fatal(e)
		}
		*enableSend, *readOnly = true, s.ReadOnly
		*ipcSocket, *openCreated, *openOnSend, *creatorBinary = s.IPCSocket, s.OpenCreated, s.OpenOnSend, s.CodexBinary
	}
	sendEnabled := *enableSend && !*readOnly
	*data, err = filepath.Abs(*data)
	if err != nil {
		log.Fatal(err)
	}
	*tokenFile, err = filepath.Abs(*tokenFile)
	if err != nil {
		log.Fatal(err)
	}
	if *supervise {
		if !filepath.IsAbs(*creatorBinary) && strings.ContainsAny(*creatorBinary, "/\\") {
			*creatorBinary, err = filepath.Abs(*creatorBinary)
			if err != nil {
				log.Fatal(err)
			}
		}
		if *diagnose || *probe != "" {
			log.Fatal("探测操作不使用守护模式")
		}
		executable, e := os.Executable()
		if e != nil {
			log.Fatal(e)
		}
		if *ipcSocket == "" {
			*ipcSocket = platform.IPCPath(*data)
		}
		if *interval < time.Second {
			*interval = 3 * time.Second
		}
		cfg := supervisor.Config{Version: 1, Executable: executable, Service: supervisor.ServiceConfig{
			TLS: *useTLS, Listen: *listen, Name: platform.ComputerName(), Home: *data, TokenFile: *tokenFile, RequireToken: *requireToken, AllowHost: *hosts, Interval: interval.String(), ReadOnly: !sendEnabled,
			IPCSocket: *ipcSocket, OpenCreated: *openCreated, OpenOnSend: *openOnSend, CodexBinary: *creatorBinary,
		}}
		if err = supervisor.Boot(ctx, *guardianConfig, cfg); err != nil {
			log.Fatal(err)
		}
		return
	}
	store, err := chat.New(*data)
	if err != nil {
		log.Fatal(err)
	}
	if *ipcSocket == "" {
		*ipcSocket = platform.IPCPath(*data)
	}
	desktopClient := &desktop.Client{Home: *data, Socket: *ipcSocket, BeforeQueuedStart: func(id string) bool { store.RefreshThread(id); ready, _ := store.QueueReady(id); return ready }}
	if *probe != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if e := desktopClient.Probe(ctx, *probe); e != nil {
			log.Fatal(e)
		}
		fmt.Println("已找到该聊天的桌面接收方（未发送消息）")
		return
	}
	if *diagnose {
		store.Refresh(true)
		sidebar := store.Sidebar()
		list := sidebar.Threads
		if sidebar.Warning != "" {
			fmt.Fprintln(os.Stderr, sidebar.Warning)
		}
		n := 0
		desktop := 0
		for _, t := range list {
			n += t.Count
			if strings.Contains(strings.ToLower(t.Source), "desktop") {
				desktop++
			}
		}
		fmt.Printf("会话: %d；桌面来源: %d；可显示消息: %d\n", len(list), desktop, n)
		return
	}
	var token string
	if *requireToken {
		token, err = loadToken(*tokenFile)
		if err != nil {
			log.Fatal(err)
		}
	}
	allowed := []string{"localhost", "127.0.0.1", "::1"}
	h, _, err := net.SplitHostPort(*listen)
	if err != nil {
		log.Fatal(err)
	}
	if h != "" && h != "0.0.0.0" && h != "::" {
		allowed = append(allowed, h)
	}
	for _, v := range strings.Split(*hosts, ",") {
		if v = strings.TrimSpace(v); v != "" {
			allowed = append(allowed, v)
		}
	}
	var outbox *delivery.Service
	if sendEnabled {
		if *openOnSend {
			desktopClient.OpenThread = platform.OpenThread
		}
		outbox, err = delivery.Open(filepath.Join(filepath.Dir(*tokenFile), "outbox.jsonl"), desktopClient)
		if err != nil {
			log.Fatal(err)
		}
		defer outbox.Close()
	}
	creator := &desktop.Creator{Binary: *creatorBinary, Home: *data, Desktop: desktopClient, Open: func(ctx context.Context, id string) error {
		return platform.OpenThread(ctx, id)
	}}
	if !*openCreated {
		creator.Open = nil
		creator.Desktop = nil
	}
	serverConfig := server.Config{PrivacyFile: *tokenFile + ".privacy.json", Creator: creator, Token: token, NoAuth: !*requireToken, AllowedHosts: allowed, AutoLocalHosts: h == "" || h == "0.0.0.0" || h == "::", Interval: *interval, Delivery: outbox, Managed: peer != nil}
	if sendEnabled {
		serverConfig.Models = &desktop.Catalog{Binary: *creatorBinary, Home: *data}
		serverConfig.Interrupt = desktopClient.Interrupt
		serverConfig.LiveControl = desktopClient
	}
	if peer != nil {
		serverConfig.GuardianStatus = peer.Status
		serverConfig.RestartService = peer.RestartService
		serverConfig.GuardianHealth = peer.HTTPHealth
	}
	app := server.New(store, serverConfig)
	health := func() {
		_ = store.Version()
		if outbox != nil {
			_ = outbox.Revision()
		}
	}
	srv := &http.Server{Addr: *listen, Handler: app, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10, BaseContext: func(net.Listener) context.Context { return ctx }}
	var tlsConfig *tls.Config
	if *useTLS {
		var fingerprint string
		tlsConfig, fingerprint, err = localtls.Server(*tokenFile + ".tls-key.pem")
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("本机 TLS 公钥指纹：%s\n", fingerprint)
	}
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	if serverConfig.AutoLocalHosts {
		_, port, _ := net.SplitHostPort(listener.Addr().String())
		bridge, e := networkbridge.New(networkbridge.Path(port))
		if e != nil {
			listener.Close()
			log.Fatal(e)
		}
		defer bridge.Close()
		var bridgeListener net.Listener = bridge
		if tlsConfig != nil {
			bridgeListener = tls.NewListener(bridge, tlsConfig)
		}
		go func() {
			if e := srv.Serve(bridgeListener); e != nil && e != http.ErrServerClosed {
				log.Printf("内嵌连接入口关闭：%v", e)
			}
		}()
	}
	if peer != nil {
		peer.Ready(health)
	}
	go app.Run(ctx)
	if outbox != nil {
		go outbox.RunQueue(ctx, func(id string) (bool, string) {
			store.RefreshThread(id)
			return store.QueueReady(id)
		})
	}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(c)
	}()
	scheme := "http"
	if tlsConfig != nil {
		listener = tls.NewListener(listener, tlsConfig)
		scheme = "https"
	}
	if *appManaged {
		payload, e := json.Marshal(map[string]string{"address": scheme + "://" + listener.Addr().String()})
		if e != nil {
			log.Fatal(e)
		}
		temp, e := os.CreateTemp(filepath.Dir(*readyFile), ".ready-")
		if e != nil {
			log.Fatal(e)
		}
		name := temp.Name()
		defer os.Remove(name)
		if _, e = temp.Write(payload); e == nil {
			e = temp.Close()
		} else {
			_ = temp.Close()
		}
		if e == nil {
			e = os.Rename(name, *readyFile)
		}
		if e != nil {
			log.Fatal(e)
		}
		defer os.Remove(*readyFile)
	}
	fmt.Printf("Codex Remote 已启动：%s://%s\n网页发送已启用：%t；手机后台暂停自动同步。\n", scheme, listener.Addr(), sendEnabled)
	if *requireToken {
		fmt.Printf("访问口令保存在：%s\n", *tokenFile)
	} else {
		fmt.Println("内网免口令模式；访问控制由监听地址与网络边界决定。")
	}
	if err = srv.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func loadToken(path string) (string, error) {
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() || !platform.PrivateMode(info) {
			return "", fmt.Errorf("口令文件必须是普通文件且权限为 0600: %s", path)
		}
		b, e := os.ReadFile(path)
		if e != nil {
			return "", e
		}
		v := strings.TrimSpace(string(b))
		if len(v) < 32 {
			return "", fmt.Errorf("口令至少需要 32 字符")
		}
		return v, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return "", err
	}
	var b [24]byte
	if _, e := rand.Read(b[:]); e != nil {
		return "", e
	}
	v := hex.EncodeToString(b[:])
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return "", e
	}
	_, e = f.WriteString(v + "\n")
	ce := f.Close()
	if e != nil {
		return "", e
	}
	return v, ce
}
