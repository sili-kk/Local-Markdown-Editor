package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
)

//go:embed web
var web embed.FS

const maxDocumentSize = 10 << 20

// Set by the release builder using -X main.buildVersion.
var buildVersion = "dev"

type config struct {
	Host           string            `yaml:"host"`
	Port           int               `yaml:"port"`
	DocsDir        directoryPaths    `yaml:"docs_dir"`
	DirectoryNames map[string]string `yaml:"directory_names,omitempty"`
	Log            logConfig         `yaml:"log"`
	Memory         memoryConfig      `yaml:"memory"`
	Permissions    permissionConfig  `yaml:"permissions"`
	ServerIPs      []string          `yaml:"server_ips"`
	FileOperations bool              `yaml:"file_operations"`
	configPath     string
}

type application struct {
	md             goldmark.Markdown
	mu             sync.RWMutex
	logger         *slog.Logger
	rootsMu        sync.RWMutex
	roots          []documentRoot
	policy         accessPolicy
	policyFault    bool
	configMu       sync.Mutex
	configPath     string
	configRevision string
	configError    string
	failedConfig   string
	memory         memoryConfig
	fileLocksMu    sync.Mutex
	fileLocks      map[string]*documentLock
	fileListing    fileListCache
	allowedNetwork netip.Prefix
	viewersMu      sync.Mutex
	viewers        map[viewerKey]documentViewer
	viewerGroups   map[string]*viewerGroup
	viewerSnapshot []viewerPresence
	viewerSweep    time.Time
	fileOpsMu      sync.Mutex
	deleteTickets  map[string]deleteTicket
	eventsMu       sync.Mutex
	documentEvents map[string]map[chan string]struct{}
}

type document struct {
	Path     string          `json:"path"`
	Content  string          `json:"content"`
	Revision string          `json:"revision"`
	HTML     string          `json:"html,omitempty"`
	Limits   *documentLimits `json:"limits,omitempty"`
	Access   string          `json:"access,omitempty"`
}

func main() {
	configPath := flag.String("config", "config.yaml", "配置文件路径")
	version := flag.Bool("version", false, "显示程序版本")
	flag.Parse()
	if *version {
		fmt.Println("Local Markdown Editor", buildVersion)
		return
	}
	if err := run(*configPath); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(configPath string) (err error) {
	configPath, err = filepath.Abs(configPath)
	if err != nil {
		return err
	}
	cfg, configData, err := readConfigFile(configPath)
	if err != nil {
		return err
	}
	previousMemoryLimit := debug.SetMemoryLimit(int64(cfg.Memory.ServerMB) << 20)
	defer debug.SetMemoryLimit(previousMemoryLimit)
	logger, logWriter, err := newLogger(cfg.Log)
	if err != nil {
		return fmt.Errorf("初始化日志失败: %w", err)
	}
	defer logWriter.Close()
	slog.SetDefault(logger)
	defer func() {
		if err != nil {
			logger.Error("服务异常退出", "error", err.Error())
		}
	}()
	roots, err := prepareConfiguredDirectories(cfg, true)
	if err != nil {
		return err
	}
	policy, err := prepareAccess(cfg, roots)
	if err != nil {
		return err
	}
	bindHost, allowedNetwork, err := parseHost(cfg.Host)
	if err != nil {
		return err
	}
	app := &application{
		allowedNetwork: allowedNetwork,
		roots:          roots,
		policy:         policy,
		configPath:     configPath,
		configRevision: revision(configData),
		logger:         logger,
		memory:         cfg.Memory,
		md: goldmark.New(
			goldmark.WithExtensions(extension.GFM, extension.Footnote, extension.DefinitionList),
			goldmark.WithParserOptions(parser.WithAutoHeadingID()),
		),
	}
	watchContext, stopWatching := context.WithCancel(context.Background())
	defer stopWatching()
	go app.watchDirectories(watchContext)
	addr := net.JoinHostPort(bindHost, fmt.Sprint(cfg.Port))
	server := &http.Server{
		Addr: addr, Handler: app.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second, WriteTimeout: 30 * time.Second,
		IdleTimeout: 60 * time.Second,
		ErrorLog:    slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}
	logger.Info("服务启动", "address", "http://"+addr, "docs_dir", cfg.DocsDir,
		"configured_host", cfg.Host, "allowed_network", allowedNetwork.String(),
		"server_memory_mb", cfg.Memory.ServerMB, "document_memory_mb", cfg.Memory.DocumentMB,
		"log_file", filepath.Join(cfg.Log.Dir, "app.log"),
		"max_size_mb", cfg.Log.MaxSizeMB, "max_backups", cfg.Log.MaxBackups,
		"max_age_days", cfg.Log.MaxAgeDays, "compress", cfg.Log.Compress)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func (a *application) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", a.index)
	mux.HandleFunc("/api/files", a.files)
	mux.HandleFunc("/api/search", a.search)
	mux.HandleFunc("/api/directories", a.directories)
	mux.HandleFunc("/api/permissions", a.permissions)
	mux.HandleFunc("/api/file", a.file)
	mux.HandleFunc("/api/documents", a.manageDocuments)
	mux.HandleFunc("/api/documents/delete-confirmation", a.confirmDocumentDeletion)
	mux.HandleFunc("/api/document-events", a.streamDocumentEvents)
	mux.HandleFunc("/api/render", a.render)
	mux.HandleFunc("/api/viewers", a.documentViewers)
	mux.HandleFunc("/api/resource", a.resource)
	mux.HandleFunc("/api/resource/image", a.resourceImage)
	mux.HandleFunc("/api/resource/html", a.resourceHTML)
	mux.HandleFunc("/api/resource/html-images", a.resourceHTMLImages)
	mux.HandleFunc("/api/resource/reveal", a.revealResource)
	mux.HandleFunc("/api/resource/open", a.openResource)
	mux.HandleFunc("/assets/", a.asset)
	staticFiles, err := fs.Sub(web, "web")
	if err != nil {
		panic(err)
	}
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.FS(staticFiles))))
	workHandler := a.documentWork(mux)
	return a.logRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		if !validRequestHost(r) {
			writeError(w, http.StatusForbidden, "请通过服务器 IP 或 localhost 访问")
			return
		}
		// Use the socket peer, never client-controlled forwarding headers.
		if !allowedClient(r.RemoteAddr, a.allowedNetwork) {
			writeError(w, http.StatusForbidden, "当前设备不在 host 配置允许访问的网段内")
			return
		}
		origin := r.Header.Get("Origin")
		openingPage := r.Method == http.MethodGet && r.URL.Path == "/" && r.Header.Get("Sec-Fetch-Mode") == "navigate" && r.Header.Get("Sec-Fetch-Dest") == "document"
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" && !openingPage || (origin != "" && origin != "http://"+r.Host) {
			writeError(w, http.StatusForbidden, "不允许跨站请求")
			return
		}
		workHandler.ServeHTTP(w, r)
	}))
}

func (a *application) index(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	if !allowMethod(w, r, http.MethodGet, http.MethodHead) {
		return
	}
	data, err := web.ReadFile("web/index.html")
	if err != nil {
		writeError(w, 500, "读取页面失败")
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}

func isMarkdown(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return ext == ".md" || ext == ".markdown"
}

func (a *application) file(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodGet, http.MethodPut) {
		return
	}
	if r.Method == http.MethodPut {
		a.save(w, r)
		return
	}
	pathValue := r.URL.Query().Get("path")
	path, canonicalPath, err := a.resolveRequest(r, pathValue, true, false)
	if err != nil {
		fileError(w, err)
		return
	}
	data, err := a.readDocument(path)
	if err != nil {
		fileError(w, err)
		return
	}
	if r.URL.Query().Get("revision_only") == "1" {
		writeJSON(w, http.StatusOK, map[string]string{"path": canonicalPath, "revision": revision(data), "access": a.requestAccess(r, path)})
		return
	}
	if err := a.checkDocumentMemory(string(data)); err != nil {
		fileError(w, err)
		return
	}
	limits := a.documentLimits()
	view := data
	if !a.localAdminRequest(r) {
		view, err = a.remoteDocument(r, canonicalPath, data)
		if err != nil {
			fileError(w, err)
			return
		}
		if err := a.checkDocumentMemory(string(view)); err != nil {
			fileError(w, err)
			return
		}
	}
	writeJSON(w, 200, document{Path: canonicalPath, Content: string(view), Revision: revision(data), Limits: &limits, Access: a.requestAccess(r, path)})
}

func (a *application) save(w http.ResponseWriter, r *http.Request) {
	var doc document
	if !a.decodeDocumentJSON(w, r, &doc) {
		return
	}
	if err := a.checkDocumentMemory(doc.Content); err != nil {
		fileError(w, err)
		return
	}
	// Keep roots stable during a save; unrelated documents can save together.
	a.mu.RLock()
	defer a.mu.RUnlock()
	path, canonicalPath, err := a.resolveRequest(r, doc.Path, true, true)
	if err != nil {
		fileError(w, err)
		return
	}
	unlock := a.lockDocument(path, true)
	defer unlock()
	if r.Context().Err() != nil {
		return
	}
	current, err := a.readDocumentUnlocked(path)
	if err != nil {
		fileError(w, err)
		return
	}
	if doc.Revision == "" || doc.Revision != revision(current) {
		writeError(w, http.StatusConflict, "本地文件已被修改，需要合并后保存。")
		return
	}
	saved := []byte(doc.Content)
	if !a.localAdminRequest(r) || strings.Contains(doc.Content, localReferenceMarker+"=") {
		saved, err = a.restoreDocumentReferences(r, canonicalPath, current, saved)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, err.Error())
			return
		}
		if err := a.checkDocumentMemory(string(saved)); err != nil {
			fileError(w, err)
			return
		}
	}
	if err := replaceFile(path, saved); err != nil {
		writeError(w, 500, "保存失败，请检查文件权限或稍后重试")
		return
	}
	writeJSON(w, 200, map[string]string{"revision": revision(saved)})
}

func (a *application) readDocument(path string) ([]byte, error) {
	unlock := a.lockDocument(path, false)
	defer unlock()
	return a.readDocumentUnlocked(path)
}

func (a *application) readDocumentUnlocked(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("路径不是普通文档文件")
	}
	limit := a.documentLimits().MaxBytes
	if info.Size() > limit {
		return nil, a.documentSizeError()
	}
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if int64(len(data)) > limit {
		return nil, a.documentSizeError()
	}
	return data, err
}

func replaceFile(path string, data []byte) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".md-editor-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(info.Mode().Perm()); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func revision(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func (a *application) renderMarkdown(data []byte) (string, error) {
	var buf bytes.Buffer
	err := a.md.Convert(data, &buf)
	return buf.String(), err
}

func (a *application) render(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodPost) {
		return
	}
	var payload struct {
		Content string `json:"content"`
	}
	if !a.decodeDocumentJSON(w, r, &payload) {
		return
	}
	if err := a.checkDocumentMemory(payload.Content); err != nil {
		fileError(w, err)
		return
	}
	html, err := a.renderMarkdown([]byte(payload.Content))
	if err != nil {
		writeError(w, 500, "预览失败")
		return
	}
	writeJSON(w, 200, map[string]string{"html": html})
}

func (a *application) asset(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodGet, http.MethodHead) {
		return
	}
	if strings.HasPrefix(r.URL.Path, "/assets/__unavailable/") {
		fileError(w, os.ErrNotExist)
		return
	}
	path, _, err := a.resolveRequest(r, strings.TrimPrefix(r.URL.Path, "/assets/"), false, false)
	if err != nil {
		fileError(w, err)
		return
	}
	// 仅提供 Markdown 常见图片，避免同源执行文档目录中的 HTML/脚本。
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico":
		http.ServeFile(w, r, path)
	default:
		writeError(w, 403, "仅支持加载本地图片资源")
	}
}

func decodeJSON(w http.ResponseWriter, r *http.Request, value any) bool {
	if strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]) != "application/json" {
		writeError(w, 415, "请使用 application/json")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 6*maxDocumentSize+4096)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(value); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "请求内容超过内存预算允许的大小")
			return false
		}
		writeError(w, 400, "请求内容无效或过大")
		return false
	}
	if decoder.Decode(new(any)) != io.EOF {
		writeError(w, 400, "请求必须是单个 JSON 对象")
		return false
	}
	return true
}

func allowMethod(w http.ResponseWriter, r *http.Request, methods ...string) bool {
	for _, method := range methods {
		if r.Method == method {
			return true
		}
	}
	w.Header().Set("Allow", strings.Join(methods, ", "))
	writeError(w, 405, "不支持此请求方法")
	return false
}

func fileError(w http.ResponseWriter, err error) {
	var pathError *os.PathError
	if errors.Is(err, errReadOnly) {
		writeError(w, http.StatusForbidden, errReadOnly.Error())
	} else if errors.Is(err, errOutsideDirectories) {
		writeError(w, http.StatusForbidden, errOutsideDirectories.Error())
	} else if errors.Is(err, errDocumentMemory) {
		writeError(w, http.StatusRequestEntityTooLarge, err.Error())
	} else if errors.Is(err, fs.ErrNotExist) {
		writeError(w, 404, "文件不存在或不可访问")
	} else if errors.As(err, &pathError) {
		writeError(w, 400, "无法访问文件")
	} else {
		writeError(w, 400, "无法访问文件: "+err.Error())
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	if recorder, ok := w.(*accessResponseWriter); ok {
		recorder.reason = message
	}
	writeJSON(w, status, map[string]string{"error": message})
}
