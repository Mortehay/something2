package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/something2/engine/internal/auth"
	"github.com/something2/engine/internal/config"
	"github.com/something2/engine/internal/game"
	"github.com/something2/engine/internal/store"
	"github.com/something2/engine/internal/ticker"
	"github.com/something2/engine/internal/ws"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	log.Printf("engine starting: port=%s tick=%dHz flush=%s", cfg.Port, cfg.TickHz, cfg.FlushInterval)

	rootCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	bootCtx, bootCancel := context.WithTimeout(rootCtx, 10*time.Second)
	defer bootCancel()

	pg, err := store.NewPostgres(bootCtx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("postgres: %v", err)
	}
	defer pg.Close()

	rdb, err := store.NewRedis(bootCtx, cfg.RedisURL)
	if err != nil {
		log.Fatalf("redis: %v", err)
	}
	defer rdb.Close()

	world := game.NewWorld(cfg.GridCellSize)
	hub := ws.NewHub(world, rdb)
	loop := game.NewLoop(world, hub, cfg.TickHz)
	flusher := ticker.NewFlusher(world, pg, cfg.FlushInterval)

	// Background workers.
	go loop.Run(rootCtx)
	go flusher.Run(rootCtx)

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.Handle("/ws", auth.Middleware(cfg.JWTSecret, http.HandlerFunc(hub.HandleWS)))

	srv := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	serverErr := make(chan error, 1)
	go func() {
		log.Printf("listening on :%s", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
		close(serverErr)
	}()

	select {
	case <-rootCtx.Done():
		log.Printf("signal received, shutting down")
	case err := <-serverErr:
		if err != nil {
			log.Printf("http server: %v", err)
		}
	}

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Printf("server shutdown: %v", err)
	}
	hub.CloseAll()
	stop() // ensure background workers see ctx cancellation
	log.Printf("engine stopped")
}
