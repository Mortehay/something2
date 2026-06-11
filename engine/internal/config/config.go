package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Port           string
	TickHz         int
	FlushInterval  time.Duration
	IdleEvict      time.Duration
	AOIRadius      float64
	GridCellSize   float64
	DatabaseURL    string
	RedisURL       string
	JWTSecret      []byte
	LogLevel       string
}

func Load() (*Config, error) {
	jwtSecret := os.Getenv("JWT_SECRET")
	if jwtSecret == "" {
		return nil, fmt.Errorf("JWT_SECRET is required")
	}
	dbURL := os.Getenv("DATABASE_URL")
	if dbURL == "" {
		return nil, fmt.Errorf("DATABASE_URL is required")
	}
	redisURL := os.Getenv("REDIS_URL")
	if redisURL == "" {
		return nil, fmt.Errorf("REDIS_URL is required")
	}

	flushInterval, err := parseDuration("ENGINE_FLUSH_INTERVAL", 5*time.Minute)
	if err != nil {
		return nil, err
	}
	idleEvict, err := parseDuration("ENGINE_IDLE_EVICT", 10*time.Minute)
	if err != nil {
		return nil, err
	}

	return &Config{
		Port:          getenv("ENGINE_PORT", "8080"),
		TickHz:        parseInt("ENGINE_TICK_HZ", 60),
		FlushInterval: flushInterval,
		IdleEvict:     idleEvict,
		AOIRadius:     parseFloat("ENGINE_AOI_RADIUS", 30),
		GridCellSize:  parseFloat("ENGINE_GRID_CELL_SIZE", 4),
		DatabaseURL:   dbURL,
		RedisURL:      redisURL,
		JWTSecret:     []byte(jwtSecret),
		LogLevel:      getenv("LOG_LEVEL", "info"),
	}, nil
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func parseInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func parseFloat(key string, def float64) float64 {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return def
	}
	return f
}

func parseDuration(key string, def time.Duration) (time.Duration, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("invalid %s=%q: %w", key, v, err)
	}
	return d, nil
}
