package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

type documentRoot struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Path   string `json:"path,omitempty"`
	IsFile bool   `json:"is_file,omitempty"`
}

type directoryState struct {
	Directories []documentRoot `json:"directories"`
	Revision    string         `json:"config_revision,omitempty"`
	Error       string         `json:"config_error,omitempty"`
	LocalAdmin  bool           `json:"local_admin"`
}

type fileListCache struct {
	mu         sync.Mutex
	at         time.Time
	roots      string
	loading    *fileListScan
	generation uint64
	fileListResult
}

type fileListResult struct {
	files, folders, warnings []string
}

type fileListScan struct {
	done chan struct{}
	err  error
}

func directoryKey(path string) string {
	path = filepath.Clean(path)
	if runtime.GOOS == "windows" {
		path = strings.ToLower(path)
	}
	return path
}

func prepareDirectories(paths []string, create bool) ([]documentRoot, error) {
	roots := make([]documentRoot, 0, len(paths))
	seen := make(map[string]bool)
	for _, path := range paths {
		if create && !isMarkdown(path) {
			if err := os.MkdirAll(path, 0755); err != nil {
				return nil, fmt.Errorf("创建目录 %q 失败: %w", path, err)
			}
		}
		resolved, err := resolveFilesystemPath(path)
		if err != nil {
			return nil, fmt.Errorf("无法加载目录 %q: %w", path, err)
		}
		info, err := os.Stat(resolved)
		if err != nil {
			return nil, fmt.Errorf("无法读取目录 %q: %w", path, err)
		}
		if !info.IsDir() && (!info.Mode().IsRegular() || !isMarkdown(resolved)) {
			return nil, fmt.Errorf("%q 必须为目录或 Markdown 文件", path)
		}
		// 确认有权限列出该目录，再写入配置。
		f, err := os.Open(resolved)
		if err != nil {
			return nil, fmt.Errorf("无法打开目录 %q: %w", path, err)
		}
		var readErr error
		if info.IsDir() {
			_, readErr = f.Readdirnames(1)
		}
		f.Close()
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return nil, fmt.Errorf("无法列出目录 %q: %w", path, readErr)
		}
		key := directoryKey(resolved)
		if seen[key] {
			continue
		}
		seen[key] = true
		roots = append(roots, documentRoot{ID: "@" + revision([]byte(key))[:16], Name: filepath.Base(resolved), Path: resolved, IsFile: !info.IsDir()})
	}
	return roots, nil
}

func validDirectoryName(name string) bool {
	return strings.TrimSpace(name) != "" && utf8.RuneCountInString(name) <= 80 && !strings.ContainsFunc(name, unicode.IsControl)
}

func prepareConfiguredDirectories(cfg config, create bool) ([]documentRoot, error) {
	roots, err := prepareDirectories(cfg.DocsDir, create)
	if err != nil {
		return nil, err
	}
	for i := range roots {
		if name, ok := cfg.DirectoryNames[roots[i].ID]; ok {
			if !validDirectoryName(name) {
				return nil, errors.New("路径显示名称必填，最多 80 个字符，不能包含控制字符")
			}
			roots[i].Name = strings.TrimSpace(name)
		}
	}
	return roots, nil
}

func (a *application) directorySnapshot() directoryState {
	a.rootsMu.RLock()
	defer a.rootsMu.RUnlock()
	return directoryState{Directories: append([]documentRoot{}, a.roots...), Revision: a.configRevision, Error: a.configError}
}

func (a *application) applyDirectories(roots []documentRoot, checksum string, policy accessPolicy) {
	// 与保存文档共用锁，避免目录撤销后仍开始向该目录写入。
	a.mu.Lock()
	defer a.mu.Unlock()
	a.rootsMu.Lock()
	a.roots, a.configRevision, a.configError = roots, checksum, ""
	a.policy, a.policyFault = policy, false
	a.rootsMu.Unlock()
	a.failedConfig = ""
}

func (a *application) configFailure(key string, err error) error {
	a.rootsMu.Lock()
	a.configError = "目录配置未更新，继续使用上次有效配置：" + err.Error()
	a.policyFault = true
	a.rootsMu.Unlock()
	if a.failedConfig != key && a.logger != nil {
		a.logger.Error("目录配置热重载失败", "error", err.Error())
	}
	a.failedConfig = key
	return err
}

func (a *application) reloadDirectories() error {
	a.configMu.Lock()
	defer a.configMu.Unlock()
	data, err := os.ReadFile(a.configPath)
	if err != nil {
		return a.configFailure(err.Error(), err)
	}
	checksum := revision(data)
	if checksum == a.directorySnapshot().Revision {
		a.rootsMu.Lock()
		a.configError = ""
		a.policyFault = false
		a.rootsMu.Unlock()
		a.failedConfig = ""
		return nil
	}
	cfg, err := parseConfig(data, a.configPath)
	if err != nil {
		return a.configFailure(checksum, err)
	}
	roots, err := prepareConfiguredDirectories(cfg, false)
	if err != nil {
		return a.configFailure(checksum, err)
	}
	policy, err := prepareAccess(cfg, roots)
	if err != nil {
		return a.configFailure(checksum, err)
	}
	a.applyDirectories(roots, checksum, policy)
	if a.logger != nil {
		a.logger.Info("文档目录已热重载", "directories", cfg.DocsDir)
	}
	return nil
}

func (a *application) watchDirectories(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = a.reloadDirectories()
		}
	}
}

func (a *application) directories(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodGet, http.MethodPut) {
		return
	}
	if !a.requireLocalAdmin(w, r) {
		return
	}
	if r.Method == http.MethodGet {
		_ = a.reloadDirectories()
		state := a.directorySnapshot()
		state.LocalAdmin = a.localAdminRequest(r)
		writeJSON(w, 200, state)
		return
	}
	var payload struct {
		Paths       []string          `json:"paths"`
		Revision    string            `json:"config_revision"`
		Permissions *permissionConfig `json:"permissions,omitempty"`
		Names       []string          `json:"names,omitempty"`
	}
	if !decodeJSON(w, r, &payload) {
		return
	}
	paths, err := normalizeDirectories(payload.Paths, a.configPath)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	roots, err := prepareDirectories(paths, false)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	a.configMu.Lock()
	defer a.configMu.Unlock()
	data, err := os.ReadFile(a.configPath)
	if err != nil {
		writeError(w, 500, "读取配置失败: "+err.Error())
		return
	}
	if payload.Revision == "" || payload.Revision != revision(data) {
		writeError(w, 409, "配置已在其他页面或外部修改，请重新读取路径后重试")
		return
	}
	// 不用页面表单覆盖尚未修复的无效配置。
	priorConfig, err := parseConfig(data, a.configPath)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	priorRoots, err := prepareDirectories(priorConfig.DocsDir, false)
	if err != nil {
		fileError(w, err)
		return
	}
	priorPolicy, err := prepareAccess(priorConfig, priorRoots)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	// Resolve submitted virtual rules against the original configured roots
	// before pruning removed paths. Validate the whole change before writing.
	if payload.Permissions != nil {
		priorConfig.Permissions = *payload.Permissions
		priorPolicy, err = prepareAccess(priorConfig, priorRoots)
		if err != nil {
			writeError(w, 400, err.Error())
			return
		}
	}
	updated, err := patchDirectoryConfig(data, paths)
	if err != nil {
		writeError(w, 500, "更新配置失败: "+err.Error())
		return
	}
	cfg, err := parseConfig(updated, a.configPath)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	namesByPath := map[string]string{}
	if payload.Names != nil {
		if len(payload.Names) != len(payload.Paths) {
			writeError(w, 400, "请为每个路径填写显示名称")
			return
		}
		for i, raw := range payload.Paths {
			name := strings.TrimSpace(payload.Names[i])
			if !validDirectoryName(name) {
				writeError(w, 400, "路径显示名称必填，最多 80 个字符，不能包含控制字符")
				return
			}
			normalized, err := normalizeDirectories([]string{raw}, a.configPath)
			if err != nil {
				fileError(w, err)
				return
			}
			resolved, err := filepath.EvalSymlinks(normalized[0])
			if err != nil {
				fileError(w, err)
				return
			}
			key := directoryKey(resolved)
			if previous, ok := namesByPath[key]; ok && previous != name {
				writeError(w, 400, "同一个路径不能设置不同的显示名称")
				return
			}
			namesByPath[key] = name
		}
	}
	labels := map[string]string{}
	for i := range roots {
		name, exists := namesByPath[directoryKey(roots[i].Path)]
		if !exists {
			name, exists = cfg.DirectoryNames[roots[i].ID]
		}
		if exists {
			if !validDirectoryName(name) {
				writeError(w, 400, "路径显示名称无效")
				return
			}
			roots[i].Name = strings.TrimSpace(name)
			labels[roots[i].ID] = roots[i].Name
		}
	}
	updated, err = patchConfigField(updated, "directory_names", labels)
	if err != nil {
		writeError(w, 500, "更新路径名称失败")
		return
	}
	// Removing a configured path also removes its obsolete permission rules.
	cfg.Permissions.Default = priorPolicy.Permissions.Default
	cfg.Permissions.Rules = []pathPermission{}
	for _, rule := range priorPolicy.Permissions.Rules {
		if withinDirectories(rule.Path, roots) {
			cfg.Permissions.Rules = append(cfg.Permissions.Rules, rule)
		}
	}
	policy, err := prepareAccess(cfg, roots)
	if err != nil {
		writeError(w, 400, err.Error())
		return
	}
	updated, err = patchConfigField(updated, "permissions", policy.Permissions)
	if err != nil {
		writeError(w, 500, "更新权限配置失败")
		return
	}
	latest, err := os.ReadFile(a.configPath)
	if err != nil || revision(latest) != revision(data) {
		writeError(w, 409, "配置文件已变化，请重新读取路径后重试")
		return
	}
	if err := replaceFile(a.configPath, updated); err != nil {
		writeError(w, 500, "保存配置失败: "+err.Error())
		return
	}
	a.applyDirectories(roots, revision(updated), policy)
	if a.logger != nil {
		a.logger.Info("文档目录配置已保存", "directories", paths)
	}
	state := a.directorySnapshot()
	state.LocalAdmin = true
	writeJSON(w, 200, state)
}

func (a *application) files(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodGet) {
		return
	}
	_ = a.reloadDirectories()
	state := a.directorySnapshot()
	state.LocalAdmin = a.localAdminRequest(r)
	listing, err := a.listDocumentEntries(r.Context(), state)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "目录扫描未完成，请稍后重试或缩小配置范围")
		return
	}
	files, warnings := listing.files, listing.warnings
	access := map[string]string{}
	visible := make([]string, 0, len(files))
	visibleRoots := map[string]bool{}
	for _, file := range files {
		path, _, err := a.documentCandidate(file, true)
		if err != nil || !a.readable(r, path) {
			continue
		}
		visible = append(visible, file)
		access[file] = a.requestAccess(r, path)
		visibleRoots[strings.SplitN(file, "/", 2)[0]] = true
	}
	files = visible
	if !state.LocalAdmin {
		public := []documentRoot{}
		for _, root := range state.Directories {
			if visibleRoots[root.ID] || a.readable(r, root.Path) {
				root.Path = ""
				public = append(public, root)
			}
		}
		state.Directories = public
		state.Revision = ""
		state.Error = ""
		warnings = []string{}
	}
	var folders []string
	if a.fileOperationsAllowed(r) {
		folders = listing.folders
	}
	writeJSON(w, 200, struct {
		directoryState
		Files          []string          `json:"files"`
		Warnings       []string          `json:"warnings"`
		Limits         documentLimits    `json:"limits"`
		FileAccess     map[string]string `json:"file_access"`
		FileOperations bool              `json:"file_operations"`
		Folders        []string          `json:"folders,omitempty"`
	}{state, files, warnings, a.documentLimits(), access, a.fileOperationsAllowed(r), folders})
}

// These directories contain dependencies/repository internals, often tens of
// thousands of entries. An explicitly configured root is still scanned.
func skipLibraryDirectory(path string, entry fs.DirEntry, root documentRoot) bool {
	return path != root.Path && entry.IsDir() && (entry.Name() == "node_modules" || entry.Name() == ".git")
}

// Files, management folders and permission targets share one immutable scan.
// Waiters can cancel without holding a mutex or cancelling other clients' work.
func (a *application) listDocumentEntries(ctx context.Context, state directoryState) (fileListResult, error) {
	key := ""
	for _, root := range state.Directories {
		key += "\x00" + root.ID + "\x00" + root.Path
	}
	cache := &a.fileListing
	for {
		if err := ctx.Err(); err != nil {
			return fileListResult{}, err
		}
		cache.mu.Lock()
		if cache.roots == key && !cache.at.IsZero() && time.Since(cache.at) < time.Second {
			result := cache.fileListResult
			cache.mu.Unlock()
			return result, nil
		}
		loading := cache.loading
		if loading == nil {
			loading = &fileListScan{done: make(chan struct{})}
			cache.loading = loading
			generation := cache.generation
			go func() {
				scanCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				result, err := scanDocumentEntries(scanCtx, state)
				cache.mu.Lock()
				loading.err = err
				if err == nil && generation == cache.generation {
					cache.roots, cache.at, cache.fileListResult = key, time.Now(), result
				}
				cache.loading = nil
				close(loading.done)
				cache.mu.Unlock()
			}()
		}
		cache.mu.Unlock()
		select {
		case <-ctx.Done():
			return fileListResult{}, ctx.Err()
		case <-loading.done:
			if loading.err != nil {
				return fileListResult{}, loading.err
			}
		}
	}
}

func scanDocumentEntries(ctx context.Context, state directoryState) (fileListResult, error) {
	result := fileListResult{files: []string{}, folders: []string{}, warnings: []string{}}
	for _, root := range state.Directories {
		err := filepath.WalkDir(root.Path, func(path string, entry fs.DirEntry, walkErr error) error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if walkErr != nil {
				result.warnings = append(result.warnings, "无法加载 "+path+": "+walkErr.Error())
				return nil
			}
			if skipLibraryDirectory(path, entry, root) {
				return fs.SkipDir
			}
			if entry.Type()&os.ModeSymlink != 0 {
				if entry.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if entry.IsDir() {
				resolved, err := confinedPath(path, []documentRoot{root}, false)
				if err != nil || directoryKey(resolved) != directoryKey(path) {
					return fs.SkipDir
				}
				result.folders = append(result.folders, virtualPath(root, path))
			} else if isMarkdown(entry.Name()) {
				result.files = append(result.files, virtualPath(root, path))
			}
			return nil
		})
		if ctx.Err() != nil {
			return fileListResult{}, ctx.Err()
		}
		if err != nil {
			result.warnings = append(result.warnings, err.Error())
		}
	}
	sort.Slice(result.files, func(i, j int) bool { return strings.ToLower(result.files[i]) < strings.ToLower(result.files[j]) })
	return result, nil
}

// search scans configured Markdown documents for a case-insensitive substring match.
func (a *application) search(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodGet) {
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		writeJSON(w, http.StatusOK, map[string]any{"files": []string{}})
		return
	}
	if len([]rune(query)) > 2000 {
		writeError(w, http.StatusBadRequest, "搜索关键词不能超过 2000 个字符")
		return
	}
	_ = a.reloadDirectories()
	state := a.directorySnapshot()
	matcher := newDocumentMatcher(query)
	reader := bufio.NewReaderSize(nil, 64<<10)
	files, warnings := make([]string, 0), make([]string, 0)
	skippedLarge, skippedRead := 0, 0
	const maxSearchResults = 10000
	for _, root := range state.Directories {
		err := filepath.WalkDir(root.Path, func(path string, entry fs.DirEntry, walkErr error) error {
			if err := r.Context().Err(); err != nil {
				return err
			}
			if walkErr != nil {
				skippedRead++
				return nil
			}
			if skipLibraryDirectory(path, entry, root) {
				return fs.SkipDir
			}
			if entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !isMarkdown(entry.Name()) {
				return nil
			}
			if !a.readable(r, path) {
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				skippedRead++
				return nil
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			unlock := a.lockDocument(path, false)
			matched, err := matcher.matchFile(r.Context(), path, reader)
			unlock()
			if err != nil {
				if r.Context().Err() != nil {
					return r.Context().Err()
				}
				if errors.Is(err, errSearchFileSize) {
					skippedLarge++
				} else {
					skippedRead++
				}
				return nil
			}
			if matched {
				files = append(files, virtualPath(root, path))
				if len(files) >= maxSearchResults {
					return fs.SkipAll
				}
			}
			return nil
		})
		if err != nil {
			warnings = append(warnings, err.Error())
		}
		if len(files) >= maxSearchResults {
			warnings = append(warnings, "最多显示前 10000 篇匹配文档，请缩小检索范围")
			break
		}
	}
	if r.Context().Err() != nil {
		return
	}
	if skippedLarge > 0 {
		warnings = append(warnings, fmt.Sprintf("已跳过 %d 篇超过 10 MB 的文档", skippedLarge))
	}
	if skippedRead > 0 {
		warnings = append(warnings, fmt.Sprintf("%d 个文件或目录无法读取", skippedRead))
	}
	if !a.localAdminRequest(r) {
		warnings = []string{}
	}
	sort.Slice(files, func(i, j int) bool { return strings.ToLower(files[i]) < strings.ToLower(files[j]) })
	writeJSON(w, http.StatusOK, struct {
		Files    []string `json:"files"`
		Warnings []string `json:"warnings,omitempty"`
	}{files, warnings})
}

// 只访问已配置目录中的普通文件；根目录 ID 在增删、重排路径后保持稳定。
func (a *application) resolve(value string, markdownOnly bool) (string, string, error) {
	candidate, root, err := a.documentCandidate(value, markdownOnly)
	if err != nil {
		return "", "", err
	}
	path, err := confinedPath(candidate, []documentRoot{root}, false)
	if err != nil {
		return "", "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", "", err
	}
	if !info.Mode().IsRegular() {
		return "", "", errors.New("路径不是普通文件")
	}
	if markdownOnly && !isMarkdown(path) {
		return "", "", errors.New("只允许操作 .md 和 .markdown 文件")
	}
	return path, virtualPath(root, path), nil
}

func (a *application) documentCandidate(value string, markdownOnly bool) (string, documentRoot, error) {
	roots := a.directorySnapshot().Directories
	if len(roots) == 0 {
		return "", documentRoot{}, errors.New("尚未配置文档目录")
	}
	root := roots[0]
	parts := strings.SplitN(value, "/", 2)
	if len(parts[0]) == 17 && strings.HasPrefix(parts[0], "@") {
		found := false
		for _, candidate := range roots {
			if candidate.ID == parts[0] {
				root, found = candidate, true
				break
			}
		}
		if !found || len(parts) != 2 {
			return "", documentRoot{}, errors.New("文档目录已移除或不存在，请更新路径配置")
		}
		value = parts[1]
	}
	if value == "" || !filepath.IsLocal(filepath.FromSlash(value)) || strings.ContainsAny(value, "\\:") {
		return "", documentRoot{}, errors.New("文件路径无效")
	}
	if markdownOnly && !isMarkdown(value) {
		return "", documentRoot{}, errors.New("只允许操作 .md 和 .markdown 文件")
	}
	if root.IsFile {
		if directoryKey(value) != directoryKey(filepath.Base(root.Path)) {
			return "", documentRoot{}, os.ErrNotExist
		}
		return root.Path, root, nil
	}
	return filepath.Join(root.Path, filepath.FromSlash(value)), root, nil
}
