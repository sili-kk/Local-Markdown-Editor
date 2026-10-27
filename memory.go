package main

import (
	"errors"
	"fmt"
	"net/http"
	"runtime/metrics"
	"strings"
)

const documentMemoryFactor = 128

var errDocumentMemory = errors.New("文档超出内存预算")

type memoryConfig struct {
	ServerMB   int `yaml:"server_mb"`
	DocumentMB int `yaml:"document_mb"`
}

type documentLimits struct {
	MemoryBytes int64 `json:"memory_bytes"`
	MaxBytes    int64 `json:"max_bytes"`
}

func (a *application) memorySettings() memoryConfig {
	settings := a.memory
	if settings.ServerMB == 0 {
		settings.ServerMB = 256
	}
	if settings.DocumentMB == 0 {
		settings.DocumentMB = 128
	}
	return settings
}

func (a *application) documentLimits() documentLimits {
	budget := int64(a.memorySettings().DocumentMB) << 20
	return documentLimits{MemoryBytes: budget, MaxBytes: min(int64(maxDocumentSize), budget/documentMemoryFactor)}
}

func (a *application) documentSizeError() error {
	limits := a.documentLimits()
	return fmt.Errorf("%w：单篇预算 %d MB，原文最多 %.2f MB；可用系统编辑器打开，或调整 memory.document_mb 后重启", errDocumentMemory, limits.MemoryBytes>>20, float64(limits.MaxBytes)/(1<<20))
}

func estimatedDocumentMemory(content string) int64 {
	// Include source copies, editor nodes and table/list/code markers. This is a
	// conservative admission estimate, not a measurement of browser heap usage.
	return int64(len(content))*documentMemoryFactor + int64(strings.Count(content, "\n")+1)*1024 + int64(strings.Count(content, "|")+strings.Count(content, "[")+strings.Count(content, "`"))*512
}

func (a *application) checkDocumentMemory(content string) error {
	limits := a.documentLimits()
	if int64(len(content)) > limits.MaxBytes || estimatedDocumentMemory(content) > limits.MemoryBytes {
		return a.documentSizeError()
	}
	return nil
}

// Do not impose a fixed request/user count. Reject new document work only when
// live heap usage is near the configured memory budget, before decoding bodies.
func (a *application) documentWork(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/file" && r.URL.Path != "/api/render" && r.URL.Path != "/api/search" && r.URL.Path != "/api/resource/html" && r.URL.Path != "/api/resource/html-images" {
			next.ServeHTTP(w, r)
			return
		}
		if r.Context().Err() != nil {
			return
		}
		samples := []metrics.Sample{{Name: "/memory/classes/heap/objects:bytes"}}
		metrics.Read(samples)
		if samples[0].Value.Uint64() >= uint64(a.memorySettings().ServerMB)*(1<<20)*85/100 {
			w.Header().Set("Retry-After", "1")
			writeError(w, http.StatusServiceUnavailable, "服务内存使用接近上限，已暂停加载，请稍后重试")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *application) decodeDocumentJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 6*a.documentLimits().MaxBytes+4096)
	return decodeJSON(w, r, value)
}
