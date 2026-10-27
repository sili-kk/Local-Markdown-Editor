package main

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"gopkg.in/natefinch/lumberjack.v2"
)

type logConfig struct {
	Dir        string `yaml:"dir"`
	MaxSizeMB  int    `yaml:"max_size_mb"`
	MaxBackups int    `yaml:"max_backups"`
	MaxAgeDays int    `yaml:"max_age_days"`
	Compress   bool   `yaml:"compress"`
}

func newLogger(cfg logConfig) (*slog.Logger, io.Closer, error) {
	if err := os.MkdirAll(cfg.Dir, 0755); err != nil {
		return nil, nil, err
	}
	writer := &lumberjack.Logger{
		Filename:   filepath.Join(cfg.Dir, "app.log"),
		MaxSize:    cfg.MaxSizeMB,
		MaxBackups: cfg.MaxBackups,
		MaxAge:     cfg.MaxAgeDays,
		Compress:   cfg.Compress,
		LocalTime:  true,
	}
	// 启动时确认文件可写，避免服务启动后才发现日志无法落盘。
	if _, err := writer.Write(nil); err != nil {
		_ = writer.Close()
		return nil, nil, err
	}
	logger := slog.New(slog.NewJSONHandler(io.MultiWriter(writer, os.Stderr), nil))
	return logger, writer, nil
}

type accessResponseWriter struct {
	http.ResponseWriter
	status   int
	bytes    int64
	reason   string
	writeErr error
}

func (w *accessResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *accessResponseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.ResponseWriter.WriteHeader(status)
	if status >= 200 || status == http.StatusSwitchingProtocols {
		w.status = status
	}
}

func (w *accessResponseWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(data)
	w.bytes += int64(n)
	if err != nil {
		w.writeErr = err
	}
	return n, err
}

func (a *application) logRequests(next http.Handler) http.Handler {
	logger := a.logger
	if logger == nil {
		logger = slog.Default()
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		recorder := &accessResponseWriter{ResponseWriter: w}
		defer func() {
			panicValue := recover()
			status := recorder.status
			if status == 0 {
				status = http.StatusOK
			}
			outcome, level := "success", slog.LevelInfo
			switch {
			case panicValue != nil:
				if recorder.status == 0 {
					status = http.StatusInternalServerError
				}
				outcome, level = "error", slog.LevelError
				recorder.reason = fmt.Sprintf("panic: %v", panicValue)
			case status >= 500:
				outcome, level = "error", slog.LevelError
			case recorder.writeErr != nil:
				outcome, level = "error", slog.LevelError
				recorder.reason = recorder.writeErr.Error()
			case status >= 400:
				outcome, level = "rejected", slog.LevelWarn
			case status >= 300 && status != http.StatusNotModified:
				outcome = "redirect"
			}
			if recorder.reason == "" && status >= 400 {
				recorder.reason = http.StatusText(status)
			}
			fields := []any{
				"outcome", outcome, "method", r.Method, "uri", r.URL.RequestURI(),
				"remote_addr", r.RemoteAddr, "status", status, "bytes", recorder.bytes,
				"duration_ms", float64(time.Since(started).Microseconds()) / 1000,
				"user_agent", r.UserAgent(),
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				fields = append(fields, "origin", origin)
			}
			if site := r.Header.Get("Sec-Fetch-Site"); site != "" {
				fields = append(fields, "sec_fetch_site", site)
			}
			if recorder.reason != "" {
				fields = append(fields, "reason", recorder.reason)
			}
			logger.Log(r.Context(), level, "HTTP访问", fields...)
			if panicValue != nil {
				panic(panicValue)
			}
		}()
		next.ServeHTTP(recorder, r)
	})
}
