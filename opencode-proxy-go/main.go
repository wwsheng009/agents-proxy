package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	var (
		configPath = flag.String("config", "config.yaml", "配置文件路径（YAML）")
		listen     = flag.String("listen", "", "监听地址（覆盖配置，如 0.0.0.0:8788）")
		upstream   = flag.String("upstream", "", "上游 base URL（覆盖配置）")
		dbPath     = flag.String("db", "", "SQLite 路径（覆盖配置）")
		proxyURL   = flag.String("proxy", "", "出站代理（覆盖配置，如 http://127.0.0.1:10810、socks5://host:1080）")
	)
	flag.Parse()

	cfg, err := loadWithOverrides(*configPath, *listen, *upstream, *dbPath, *proxyURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(2)
	}
	if err := cfg.Validate(); err != nil {
		fmt.Fprintln(os.Stderr, "config:", err)
		os.Exit(2)
	}

	store, err := OpenStore(cfg.DBPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "store:", err)
		os.Exit(2)
	}
	defer store.Close()
	if err := store.Prune(cfg.Log.KeepDays); err != nil {
		slog.Warn("prune request_log", "err", err)
	}

	proxy, err := NewProxy(&cfg, store)
	if err != nil {
		fmt.Fprintln(os.Stderr, "proxy:", err)
		os.Exit(2)
	}

	srv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           proxy.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errCh := make(chan error, 1)
	go func() {
		slog.Info("opencode-proxy-go listening",
			"listen", cfg.Listen, "upstream", cfg.Upstream, "db", cfg.DBPath)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			fmt.Fprintln(os.Stderr, "serve:", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		slog.Info("shutting down…")
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutCtx); err != nil {
			slog.Error("shutdown", "err", err)
		}
	}
}

// loadWithOverrides 加载配置并应用 CLI 覆盖项。
func loadWithOverrides(path, listen, upstream, db, proxyURL string) (Config, error) {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			// 显式指定的 -config 缺失视为错误；默认路径缺失回退内置默认
			explicit := false
			flag.Visit(func(f *flag.Flag) {
				if f.Name == "config" {
					explicit = true
				}
			})
			if explicit {
				return Config{}, fmt.Errorf("配置文件不存在: %s", path)
			}
			return DefaultConfig(), nil
		}
		return Config{}, err
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		return cfg, err
	}
	if listen != "" {
		cfg.Listen = listen
	}
	if upstream != "" {
		cfg.Upstream = upstream
	}
	if db != "" {
		cfg.DBPath = db
	}
	if proxyURL != "" {
		cfg.Proxy.URL = proxyURL
	}
	return cfg, nil
}
