package main

import (
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type resourceRequest struct {
	Path      string `json:"path"`
	Reference string `json:"reference"`
}

func decodeResourceRequest(w http.ResponseWriter, r *http.Request, payload *resourceRequest) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	return decodeJSON(w, r, payload)
}

func (a *application) resolveResource(doc, reference string) (string, error) {
	path, err := a.resolveResourceCandidate(doc, reference)
	if err != nil {
		return "", err
	}
	return confinedPath(path, a.directorySnapshot().Directories, true)
}

func (a *application) resolveResourceRequest(r *http.Request, doc, reference string) (string, error) {
	if _, _, err := a.resolveRequest(r, doc, true, false); err != nil {
		return "", err
	}
	candidate, err := a.resolveResourceCandidate(doc, reference)
	if err != nil {
		return "", err
	}
	if !a.readable(r, candidate) {
		return "", os.ErrNotExist
	}
	path, err := confinedPath(candidate, a.directorySnapshot().Directories, true)
	if err != nil {
		return "", err
	}
	if !a.readable(r, path) {
		return "", os.ErrNotExist
	}
	return path, nil
}

// Relative links, absolute paths and file URLs all pass the same final boundary
// check. A reference may target another explicitly configured library only.
func (a *application) resolveResourceCandidate(doc, reference string) (string, error) {
	base, _, err := a.resolve(doc, true)
	if err != nil {
		return "", err
	}
	return a.resolveResourceFromBase(base, doc, reference)
}

func (a *application) resolveResourceFromBase(base, doc, reference string) (string, error) {
	reference = strings.TrimSpace(reference)
	if reference == "" || len(reference) > 16384 || strings.ContainsRune(reference, 0) {
		return "", errors.New("本地资源路径无效")
	}
	// Recognize Windows paths before URL parsing treats the drive as a scheme.
	if runtime.GOOS == "windows" && (filepath.IsAbs(reference) || strings.HasPrefix(reference, `\\`)) && !strings.HasPrefix(reference, "/") {
		if decoded, err := url.PathUnescape(reference); err == nil {
			reference = decoded
		}
		return filepath.Clean(reference), nil
	}
	u, err := url.Parse(strings.ReplaceAll(reference, `\`, "/"))
	if err != nil {
		return "", errors.New("本地资源路径无效")
	}
	if strings.EqualFold(u.Scheme, "file") {
		path := u.Path
		if u.Opaque != "" {
			path = u.Opaque
		}
		if u.Host != "" && !strings.EqualFold(u.Host, "localhost") {
			path = "//" + u.Host + path
		}
		if runtime.GOOS == "windows" && len(path) > 2 && path[0] == '/' && path[2] == ':' {
			path = path[1:]
		}
		path = filepath.FromSlash(path)
		if !filepath.IsAbs(path) {
			return "", errors.New("file 链接必须使用绝对路径")
		}
		return filepath.Clean(path), nil
	}
	if u.Scheme != "" || u.Host != "" || u.Path == "" {
		return "", errors.New("仅支持本地文件路径")
	}
	if strings.HasPrefix(u.Path, "/assets/") {
		if strings.HasPrefix(u.Path, "/assets/__unavailable/") {
			return "", os.ErrNotExist
		}
		path, _, err := a.documentCandidate(strings.TrimPrefix(u.Path, "/assets/"), false)
		return path, err
	}
	path := filepath.FromSlash(u.Path)
	if strings.HasPrefix(u.Path, "/") && runtime.GOOS == "windows" {
		// Keep the editor's existing /image.png convention: library-root relative.
		canonical := strings.SplitN(doc, "/", 2)[0]
		for _, root := range a.directorySnapshot().Directories {
			if root.ID == canonical {
				return filepath.Join(root.Path, filepath.FromSlash(strings.TrimPrefix(u.Path, "/"))), nil
			}
		}
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(filepath.Dir(base), path)
	}
	return filepath.Clean(path), nil
}

func resourceImageType(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".avif":
		return "image/avif"
	case ".bmp":
		return "image/bmp"
	case ".ico":
		return "image/x-icon"
	}
	return ""
}

func isHTML(path string) bool {
	ext := strings.ToLower(filepath.Ext(path))
	return ext == ".html" || ext == ".htm"
}

func resourceCanOpen(path string, info os.FileInfo) bool {
	if info.IsDir() {
		return true
	}
	if !info.Mode().IsRegular() {
		return false
	}
	if resourceImageType(path) != "" {
		return true
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".html", ".htm", ".svg", ".pdf", ".txt", ".md", ".markdown", ".csv", ".json", ".log", ".rtf",
		".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp":
		return true
	}
	return false
}

func (a *application) resource(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodPost) {
		return
	}
	var payload resourceRequest
	if !decodeResourceRequest(w, r, &payload) {
		return
	}
	path, err := a.resolveResourceRequest(r, payload.Path, payload.Reference)
	if err != nil {
		fileError(w, err)
		return
	}
	info, err := os.Stat(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		fileError(w, err)
		return
	}
	exists, directory, image, canOpen := err == nil, false, false, false
	if exists {
		directory = info.IsDir()
		image = info.Mode().IsRegular() && resourceImageType(path) != ""
		canOpen = a.localAdminRequest(r) && resourceCanOpen(path, info)
	}
	displayPath := path
	if !a.localAdminRequest(r) {
		displayPath = a.virtualPath(path)
	}
	documentPath := ""
	htmlPath := ""
	if exists && info.Mode().IsRegular() && isMarkdown(path) {
		documentPath = a.virtualPath(path)
	}
	if exists && info.Mode().IsRegular() && isHTML(path) {
		htmlPath = a.virtualPath(path)
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": displayPath, "exists": exists, "is_directory": directory, "is_image": image, "document_path": documentPath, "html_path": htmlPath, "can_open": canOpen, "can_reveal": exists && a.localAdminRequest(r)})
}

// Return JSON only. The client places the content in a sandboxed srcdoc with
// no same-origin privilege; HTML is never served as executable editor-origin
// content, including when this API is opened directly in the browser.
func (a *application) resourceHTML(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodPost) {
		return
	}
	var payload resourceRequest
	if !decodeResourceRequest(w, r, &payload) {
		return
	}
	path, err := a.resolveResourceRequest(r, payload.Path, payload.Reference)
	if err != nil {
		fileError(w, err)
		return
	}
	if !isHTML(path) {
		writeError(w, http.StatusForbidden, "仅支持预览本地 .html 和 .htm 文件")
		return
	}
	data, err := a.readDocument(path)
	if err != nil {
		fileError(w, err)
		return
	}
	if err := a.checkDocumentMemory(string(data)); err != nil {
		fileError(w, err)
		return
	}
	if !a.localAdminRequest(r) {
		data, err = a.remoteDocument(r, payload.Path, data)
		if err != nil {
			fileError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": a.virtualPath(path), "content": string(data)})
}

// Images are returned as data URLs for the opaque-origin HTML sandbox. Never
// allow the preview to fetch editor-origin resources or execute an SVG there.
func (a *application) resourceHTMLImages(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodPost) {
		return
	}
	var payload struct {
		resourceRequest
		Images []string `json:"images"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if !decodeJSON(w, r, &payload) {
		return
	}
	if len(payload.Images) > 32 {
		writeError(w, http.StatusBadRequest, "每次预览最多加载 32 张本地图片")
		return
	}
	page, err := a.resolveResourceRequest(r, payload.Path, payload.Reference)
	if err != nil || !isHTML(page) {
		fileError(w, os.ErrNotExist)
		return
	}
	if info, err := os.Stat(page); err != nil || !info.Mode().IsRegular() {
		fileError(w, os.ErrNotExist)
		return
	}
	images := make(map[string]string)
	const maxImage = 8 << 20
	remaining := int64(24 << 20)
	for _, reference := range payload.Images {
		if r.Context().Err() != nil {
			return
		}
		if _, exists := images[reference]; exists {
			continue
		}
		candidate, err := a.resolveResourceFromBase(page, a.virtualPath(page), reference)
		if err != nil || !a.readable(r, candidate) {
			continue
		}
		path, err := confinedPath(candidate, a.directorySnapshot().Directories, false)
		if err != nil || !a.readable(r, path) {
			continue
		}
		kind := resourceImageType(path)
		if strings.EqualFold(filepath.Ext(path), ".svg") {
			kind = "image/svg+xml"
		}
		if kind == "" {
			continue
		}
		file, err := os.Open(path)
		if err != nil {
			continue
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() || info.Size() > maxImage || info.Size() > remaining {
			file.Close()
			continue
		}
		limit := min(int64(maxImage), remaining)
		data, err := io.ReadAll(io.LimitReader(file, limit+1))
		file.Close()
		if err != nil || int64(len(data)) > limit {
			continue
		}
		remaining -= int64(len(data))
		images[reference] = "data:" + kind + ";base64," + base64.StdEncoding.EncodeToString(data)
	}
	writeJSON(w, http.StatusOK, map[string]any{"images": images})
}

func (a *application) openResource(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodPost) {
		return
	}
	if !a.requireLocalAdmin(w, r) {
		return
	}
	var payload resourceRequest
	if !decodeResourceRequest(w, r, &payload) {
		return
	}
	path, err := a.resolveResourceRequest(r, payload.Path, payload.Reference)
	if err != nil {
		fileError(w, err)
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		fileError(w, err)
		return
	}
	if !resourceCanOpen(path, info) {
		writeError(w, http.StatusForbidden, "该类型暂不支持直接打开，请在资源管理器中打开")
		return
	}
	if err := openResourceFile(path); err != nil {
		writeError(w, http.StatusInternalServerError, "用默认程序打开文件失败："+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}

func (a *application) resourceImage(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodGet, http.MethodHead) {
		return
	}
	path, err := a.resolveResourceRequest(r, r.URL.Query().Get("path"), r.URL.Query().Get("reference"))
	if err != nil {
		fileError(w, err)
		return
	}
	imageType := resourceImageType(path)
	if imageType == "" {
		writeError(w, http.StatusForbidden, "仅支持预览本地图片")
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		fileError(w, err)
		return
	}
	if !info.Mode().IsRegular() {
		writeError(w, http.StatusBadRequest, "路径不是普通图片文件")
		return
	}
	w.Header().Set("Content-Type", imageType)
	http.ServeFile(w, r, path)
}

func (a *application) revealResource(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodPost) {
		return
	}
	if !a.requireLocalAdmin(w, r) {
		return
	}
	var payload resourceRequest
	if !decodeResourceRequest(w, r, &payload) {
		return
	}
	path, err := a.resolveResourceRequest(r, payload.Path, payload.Reference)
	if err != nil {
		fileError(w, err)
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		fileError(w, err)
		return
	}
	if !info.IsDir() && !info.Mode().IsRegular() {
		writeError(w, http.StatusBadRequest, "路径不是普通文件或目录")
		return
	}
	cmd := resourceRevealCommand(path, info.IsDir())
	if err := cmd.Start(); err != nil {
		writeError(w, http.StatusInternalServerError, "打开资源管理器失败："+err.Error())
		return
	}
	go func() { _ = cmd.Wait() }()
	writeJSON(w, http.StatusOK, map[string]string{"path": path})
}
