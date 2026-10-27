package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

type deleteTicket struct {
	Path, Virtual, Revision, ConfigRevision, Peer string
	Info                                          os.FileInfo
	Expires                                       time.Time
}

func (a *application) fileOperationsAllowed(r *http.Request) bool {
	policy, fault := a.accessSnapshot()
	return !fault && policy.FileOperations && a.localAdminRequest(r)
}

func (a *application) requireFileOperations(w http.ResponseWriter, r *http.Request) bool {
	if !a.requireLocalAdmin(w, r) {
		return false
	}
	if !a.fileOperationsAllowed(r) {
		writeError(w, 403, "未开启本机文件新建和删除功能")
		return false
	}
	return true
}

// Only explicit virtual paths are accepted by destructive operations. Reject
// aliases and symlinks rather than deleting the target of a followed link.
func (a *application) managedTarget(value string, directory bool) (documentRoot, string, string, error) {
	parts := strings.SplitN(value, "/", 2)
	for _, root := range a.directorySnapshot().Directories {
		if parts[0] != root.ID {
			continue
		}
		if directory && root.IsFile {
			return root, "", "", errOutsideDirectories
		}
		rel := "."
		if len(parts) == 2 {
			rel = parts[1]
		}
		if root.IsFile {
			if rel != filepath.Base(root.Path) {
				return root, "", "", errOutsideDirectories
			}
		}
		if rel == "" || (rel != "." && !filepath.IsLocal(filepath.FromSlash(rel))) || strings.ContainsAny(rel, `\:`) {
			return root, "", "", errOutsideDirectories
		}
		for _, component := range strings.Split(rel, "/") {
			if component == ".." || (component == "." && rel != ".") || strings.TrimRight(component, " .") != component && component != "." {
				return root, "", "", errOutsideDirectories
			}
		}
		path := filepath.Join(root.Path, filepath.FromSlash(rel))
		if root.IsFile {
			path = root.Path
		}
		resolved, err := confinedPath(path, []documentRoot{root}, false)
		if err != nil {
			return root, "", "", err
		}
		if directoryKey(resolved) != directoryKey(path) {
			return root, "", "", errOutsideDirectories
		}
		info, err := os.Lstat(path)
		if err != nil {
			return root, "", "", err
		}
		if info.Mode()&os.ModeSymlink != 0 || directory != info.IsDir() || (!directory && (!info.Mode().IsRegular() || !isMarkdown(path))) {
			return root, "", "", errOutsideDirectories
		}
		if !directory {
			if directoryKey(path) == directoryKey(a.configPath) {
				return root, "", "", errOutsideDirectories
			}
			if executable, err := os.Executable(); err == nil && directoryKey(path) == directoryKey(executable) {
				return root, "", "", errOutsideDirectories
			}
		}
		if root.IsFile {
			rel = filepath.Base(root.Path)
		}
		return root, filepath.FromSlash(rel), path, nil
	}
	return documentRoot{}, "", "", errOutsideDirectories
}

func openManagedRoot(root documentRoot) (*os.Root, error) {
	path := root.Path
	if root.IsFile {
		path = filepath.Dir(path)
	}
	return os.OpenRoot(path)
}

func readManagedFile(root *os.Root, rel string) (string, os.FileInfo, error) {
	file, err := root.Open(rel)
	if err != nil {
		return "", nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return "", nil, err
	}
	if !info.Mode().IsRegular() {
		return "", nil, errors.New("仅允许操作普通 Markdown 文件")
	}
	digest := sha256.New()
	_, err = io.Copy(digest, file)
	return hex.EncodeToString(digest.Sum(nil)), info, err
}

func peerAddress(r *http.Request) string { ip, _, _ := net.SplitHostPort(r.RemoteAddr); return ip }

func (a *application) confirmDocumentDeletion(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodPost) || !a.requireLocalAdmin(w, r) {
		return
	}
	if err := a.reloadDirectories(); err != nil {
		writeError(w, 403, "配置无效，禁止删除")
		return
	}
	if !a.requireFileOperations(w, r) {
		return
	}
	var payload struct {
		Path string `json:"path"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if !decodeJSON(w, r, &payload) {
		return
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	if !a.requireFileOperations(w, r) {
		return
	}
	root, rel, path, err := a.managedTarget(payload.Path, false)
	if err != nil {
		fileError(w, err)
		return
	}
	unlock := a.lockDocument(path, false)
	defer unlock()
	handle, err := openManagedRoot(root)
	if err != nil {
		fileError(w, err)
		return
	}
	defer handle.Close()
	data, info, err := readManagedFile(handle, rel)
	if err != nil {
		fileError(w, err)
		return
	}
	random := make([]byte, 32)
	if _, err = rand.Read(random); err != nil {
		writeError(w, 500, "生成确认凭据失败")
		return
	}
	token := hex.EncodeToString(random)
	a.fileOpsMu.Lock()
	if a.deleteTickets == nil {
		a.deleteTickets = map[string]deleteTicket{}
	}
	for key, ticket := range a.deleteTickets {
		if time.Now().After(ticket.Expires) {
			delete(a.deleteTickets, key)
		}
	}
	a.deleteTickets[token] = deleteTicket{path, payload.Path, data, a.directorySnapshot().Revision, peerAddress(r), info, time.Now().Add(2 * time.Minute)}
	a.fileOpsMu.Unlock()
	writeJSON(w, 200, map[string]string{"token": token, "path": payload.Path, "revision": data})
}

func validNewDocumentName(name string) bool {
	if name == "" || utf8.RuneCountInString(name) > 120 || strings.TrimSpace(name) != name || strings.TrimRight(name, " .") != name || !filepath.IsLocal(name) || strings.ContainsAny(name, `/\:*?"<>|`) {
		return false
	}
	for _, char := range name {
		if unicode.IsControl(char) {
			return false
		}
	}
	stem := strings.SplitN(strings.ToUpper(name), ".", 2)[0]
	if stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL" || len(stem) == 4 && (strings.HasPrefix(stem, "COM") || strings.HasPrefix(stem, "LPT")) && stem[3] >= '0' && stem[3] <= '9' {
		return false
	}
	return isMarkdown(name)
}

func (a *application) invalidateFileListing() {
	a.fileListing.mu.Lock()
	a.fileListing.at = time.Time{}
	a.fileListing.generation++
	a.fileListing.mu.Unlock()
}

func (a *application) manageDocuments(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodPost, http.MethodDelete) || !a.requireLocalAdmin(w, r) {
		return
	}
	if err := a.reloadDirectories(); err != nil {
		writeError(w, 403, "配置无效，禁止文件操作")
		return
	}
	var payload struct {
		Directory string `json:"directory"`
		Name      string `json:"name"`
		Path      string `json:"path"`
		Token     string `json:"token"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8192)
	if !decodeJSON(w, r, &payload) {
		return
	}
	a.configMu.Lock()
	defer a.configMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.requireFileOperations(w, r) {
		return
	}
	configData, err := os.ReadFile(a.configPath)
	if err != nil || revision(configData) != a.directorySnapshot().Revision {
		writeError(w, 409, "配置已变化，请重新加载后操作")
		return
	}
	if r.Method == http.MethodPost {
		if !validNewDocumentName(payload.Name) {
			writeError(w, 400, "请使用有效的 Markdown 文件名，不能包含路径、设备名或特殊字符")
			return
		}
		root, rel, _, err := a.managedTarget(payload.Directory, true)
		if err != nil {
			fileError(w, err)
			return
		}
		handle, err := openManagedRoot(root)
		if err != nil {
			fileError(w, err)
			return
		}
		defer handle.Close()
		target := filepath.Join(rel, payload.Name)
		file, err := handle.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
		if errors.Is(err, os.ErrExist) {
			writeError(w, 409, "同名文件已存在，不会覆盖")
			return
		}
		if err != nil {
			fileError(w, err)
			return
		}
		if err = file.Close(); err != nil {
			_ = handle.Remove(target)
			fileError(w, err)
			return
		}
		a.invalidateFileListing()
		writeJSON(w, 201, map[string]string{"path": virtualPath(root, filepath.Join(root.Path, target))})
		return
	}
	a.fileOpsMu.Lock()
	ticket, ok := a.deleteTickets[payload.Token]
	delete(a.deleteTickets, payload.Token)
	a.fileOpsMu.Unlock()
	if !ok || time.Now().After(ticket.Expires) || ticket.Virtual != payload.Path || ticket.Peer != peerAddress(r) || ticket.ConfigRevision != revision(configData) {
		writeError(w, 409, "删除确认已失效，请重新进行两次确认")
		return
	}
	root, rel, path, err := a.managedTarget(payload.Path, false)
	if err != nil {
		fileError(w, err)
		return
	}
	if directoryKey(path) != directoryKey(ticket.Path) {
		writeError(w, 409, "文件目标已变化，请重新确认")
		return
	}
	unlock := a.lockDocument(path, true)
	defer unlock()
	handle, err := openManagedRoot(root)
	if err != nil {
		fileError(w, err)
		return
	}
	defer handle.Close()
	data, info, err := readManagedFile(handle, rel)
	if err != nil {
		fileError(w, err)
		return
	}
	if !os.SameFile(info, ticket.Info) || !info.ModTime().Equal(ticket.Info.ModTime()) || data != ticket.Revision {
		writeError(w, 409, "确认后文件已修改，请重新确认删除")
		return
	}
	// Remove obsolete file roots and exact file rules before unlinking, so a
	// normal deletion cannot make the next configuration reload fail closed.
	cfg, err := parseConfig(configData, a.configPath)
	if err != nil {
		writeError(w, 409, "配置不可用")
		return
	}
	paths := directoryPaths{}
	for _, item := range a.directorySnapshot().Directories {
		if !item.IsFile || directoryKey(item.Path) != directoryKey(path) {
			paths = append(paths, item.Path)
		}
	}
	policy, _ := a.accessSnapshot()
	rules := []pathPermission{}
	for _, rule := range policy.Permissions.Rules {
		if rule.Directory || directoryKey(rule.Path) != directoryKey(path) {
			rules = append(rules, rule)
		}
	}
	cfg.DocsDir = paths
	cfg.Permissions.Rules = rules
	roots, err := prepareConfiguredDirectories(cfg, false)
	if err != nil {
		fileError(w, err)
		return
	}
	nextPolicy, err := prepareAccess(cfg, roots)
	if err != nil {
		writeError(w, 409, "权限配置不可用，请先修复配置")
		return
	}
	updated, err := patchConfigField(configData, "docs_dir", paths)
	if err == nil {
		updated, err = patchConfigField(updated, "permissions", nextPolicy.Permissions)
	}
	if err != nil {
		writeError(w, 500, "更新配置失败，未删除文件")
		return
	}
	latest, err := os.ReadFile(a.configPath)
	if err != nil || revision(latest) != revision(configData) {
		writeError(w, 409, "配置已变化，未删除文件")
		return
	}
	if err = replaceFile(a.configPath, updated); err != nil {
		writeError(w, 500, "保存配置失败，未删除文件")
		return
	}
	if err = handle.Remove(rel); err != nil {
		if restoreErr := replaceFile(a.configPath, configData); restoreErr != nil {
			_ = a.configFailure("delete-rollback", restoreErr)
		}
		writeError(w, 500, "删除失败，文件操作未完成，请检查配置和文件权限")
		return
	}
	a.rootsMu.Lock()
	a.roots = roots
	a.policy = nextPolicy
	a.configRevision = revision(updated)
	a.policyFault = false
	a.configError = ""
	a.rootsMu.Unlock()
	a.invalidateFileListing()
	a.publishDocumentEvent(path, "deleted")
	writeJSON(w, 200, map[string]bool{"deleted": true})
}
