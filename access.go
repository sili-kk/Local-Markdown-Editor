package main

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type pathPermission struct {
	Path      string `yaml:"path" json:"path"`
	Access    string `yaml:"access" json:"access"`
	Directory bool   `yaml:"-" json:"-"`
}

type permissionConfig struct {
	Default string           `yaml:"default" json:"default"`
	Rules   []pathPermission `yaml:"rules" json:"rules"`
}

type accessPolicy struct {
	Permissions    permissionConfig
	ServerIPs      []netip.Addr
	byPath         map[string]pathPermission
	FileOperations bool
}

var errReadOnly = errors.New("当前文档为只读，不能保存")

func validAccess(value string) bool { return value == "none" || value == "r" || value == "rw" }

func prepareAccess(cfg config, roots []documentRoot) (accessPolicy, error) {
	policy := accessPolicy{Permissions: permissionConfig{Default: cfg.Permissions.Default, Rules: []pathPermission{}}, byPath: map[string]pathPermission{}}
	policy.FileOperations = cfg.FileOperations
	if policy.Permissions.Default == "" {
		policy.Permissions.Default = "rw"
	}
	if !validAccess(policy.Permissions.Default) {
		return policy, errors.New("permissions.default 只能为 none、r 或 rw")
	}
	if len(cfg.Permissions.Rules) > 10000 {
		return policy, errors.New("权限规则最多 10000 条")
	}
	seen := map[string]bool{}
	for _, rule := range cfg.Permissions.Rules {
		if !validAccess(rule.Access) {
			return policy, errors.New("权限只能为 none、r 或 rw")
		}
		path, err := permissionTarget(rule.Path, cfg.configPath, roots)
		if err != nil {
			return policy, fmt.Errorf("权限路径无效 %q: %w", rule.Path, err)
		}
		key := directoryKey(path)
		if seen[key] {
			return policy, fmt.Errorf("重复的权限路径 %q", rule.Path)
		}
		seen[key] = true
		info, err := os.Stat(path)
		if err != nil {
			return policy, err
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return policy, errors.New("权限目标必须为目录或普通文件")
		}
		policy.Permissions.Rules = append(policy.Permissions.Rules, pathPermission{Path: path, Access: rule.Access, Directory: info.IsDir()})
		policy.byPath[key] = policy.Permissions.Rules[len(policy.Permissions.Rules)-1]
	}
	addresses, _ := net.InterfaceAddrs()
	for _, address := range addresses {
		prefix, err := netip.ParsePrefix(address.String())
		if err == nil {
			policy.ServerIPs = append(policy.ServerIPs, prefix.Addr().Unmap().WithZone(""))
		}
	}
	for _, value := range cfg.ServerIPs {
		address, err := netip.ParseAddr(strings.TrimSpace(value))
		if err != nil || address.IsUnspecified() || address.IsMulticast() {
			return policy, errors.New("server_ips 必须是明确的单个 IP，不能使用网段、域名或通配地址")
		}
		policy.ServerIPs = append(policy.ServerIPs, address.Unmap().WithZone(""))
	}
	return policy, nil
}

func permissionTarget(value, configPath string, roots []documentRoot) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", errOutsideDirectories
	}
	if strings.HasPrefix(value, "@") {
		parts := strings.SplitN(value, "/", 2)
		for _, root := range roots {
			if root.ID != parts[0] {
				continue
			}
			rel := ""
			if len(parts) == 2 {
				rel = parts[1]
			}
			if rel == "" || rel == "." {
				return confinedPath(root.Path, []documentRoot{root}, false)
			}
			if !filepath.IsLocal(filepath.FromSlash(rel)) || strings.ContainsAny(rel, `\:`) {
				return "", errOutsideDirectories
			}
			if root.IsFile {
				if rel != filepath.Base(root.Path) {
					return "", errOutsideDirectories
				}
				return confinedPath(root.Path, []documentRoot{root}, false)
			}
			return confinedPath(filepath.Join(root.Path, filepath.FromSlash(rel)), []documentRoot{root}, false)
		}
		return "", errOutsideDirectories
	}
	if !filepath.IsAbs(value) {
		value = filepath.Join(filepath.Dir(configPath), value)
	}
	return confinedPath(value, roots, false)
}

func (a *application) accessSnapshot() (accessPolicy, bool) {
	a.rootsMu.RLock()
	defer a.rootsMu.RUnlock()
	return a.policy, a.policyFault
}

func (a *application) pathAccess(path string) string {
	policy, fault := a.accessSnapshot()
	if fault {
		return "none"
	}
	access := policy.Permissions.Default
	if access == "" {
		access = "rw"
	}
	path = filepath.Clean(path)
	for candidate := path; ; {
		if rule, ok := policy.byPath[directoryKey(candidate)]; ok && (candidate == path || rule.Directory) {
			return rule.Access
		}
		parent := filepath.Dir(candidate)
		if parent == candidate {
			break
		}
		candidate = parent
	}
	return access
}

func (a *application) readable(r *http.Request, path string) bool {
	return a.localAdminRequest(r) || a.pathAccess(path) != "none"
}

func (a *application) requestAccess(r *http.Request, path string) string {
	if a.localAdminRequest(r) {
		return "rw"
	}
	return a.pathAccess(path)
}

// Check permissions before existence and after canonicalization, so guessed
// paths, alternate configured roots and symlink aliases cannot bypass a rule.
func (a *application) resolveRequest(r *http.Request, value string, markdown, write bool) (string, string, error) {
	candidate, _, err := a.documentCandidate(value, markdown)
	if err != nil {
		if !a.localAdminRequest(r) {
			return "", "", os.ErrNotExist
		}
		return "", "", err
	}
	if !a.readable(r, candidate) {
		return "", "", os.ErrNotExist
	}
	path, canonical, err := a.resolve(value, markdown)
	if err != nil {
		return "", "", err
	}
	if !a.readable(r, path) {
		return "", "", os.ErrNotExist
	}
	if write && a.requestAccess(r, path) != "rw" {
		return "", "", errReadOnly
	}
	return path, canonical, nil
}

func virtualPath(root documentRoot, path string) string {
	if root.IsFile {
		return root.ID + "/" + filepath.Base(root.Path)
	}
	rel, _ := filepath.Rel(root.Path, path)
	if rel == "." {
		return root.ID
	}
	return root.ID + "/" + filepath.ToSlash(rel)
}

func (a *application) virtualPath(path string) string {
	for _, root := range a.directorySnapshot().Directories {
		if withinDirectories(path, []documentRoot{root}) {
			return virtualPath(root, path)
		}
	}
	return ""
}

func (a *application) permissionPath(path string) string {
	for _, root := range a.directorySnapshot().Directories {
		if withinDirectories(path, []documentRoot{root}) {
			if root.IsFile {
				return root.ID
			}
			return virtualPath(root, path)
		}
	}
	return ""
}

func (a *application) permissions(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodGet, http.MethodPut) || !a.requireLocalAdmin(w, r) {
		return
	}
	if r.Method == http.MethodPut {
		var payload struct {
			permissionConfig
			Revision string `json:"config_revision"`
		}
		r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
		if !decodeJSON(w, r, &payload) {
			return
		}
		a.configMu.Lock()
		defer a.configMu.Unlock()
		data, err := os.ReadFile(a.configPath)
		if err != nil {
			writeError(w, 500, "读取配置失败")
			return
		}
		if payload.Revision == "" || payload.Revision != revision(data) {
			writeError(w, 409, "配置已变化，请重新读取后重试")
			return
		}
		cfg, err := parseConfig(data, a.configPath)
		if err != nil {
			writeError(w, 400, err.Error())
			return
		}
		roots, err := prepareConfiguredDirectories(cfg, false)
		if err != nil {
			fileError(w, err)
			return
		}
		cfg.Permissions = payload.permissionConfig
		policy, err := prepareAccess(cfg, roots)
		if err != nil {
			writeError(w, 400, err.Error())
			return
		}
		updated, err := patchConfigField(data, "permissions", policy.Permissions)
		if err != nil {
			writeError(w, 500, "更新权限失败")
			return
		}
		latest, err := os.ReadFile(a.configPath)
		if err != nil || revision(latest) != revision(data) {
			writeError(w, 409, "配置已变化，请重试")
			return
		}
		if err = replaceFile(a.configPath, updated); err != nil {
			writeError(w, 500, "保存权限失败")
			return
		}
		a.applyDirectories(roots, revision(updated), policy)
	} else {
		_ = a.reloadDirectories()
	}
	state := a.directorySnapshot()
	listing, err := a.listDocumentEntries(r.Context(), state)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "权限目录扫描未完成，请稍后重试或缩小配置范围")
		return
	}
	policy, _ := a.accessSnapshot()
	permissions := permissionConfig{Default: policy.Permissions.Default, Rules: []pathPermission{}}
	for _, rule := range policy.Permissions.Rules {
		permissions.Rules = append(permissions.Rules, pathPermission{Path: a.permissionPath(rule.Path), Access: rule.Access})
	}
	targets := map[string]string{}
	for _, root := range state.Directories {
		kind := "directory"
		if root.IsFile {
			kind = "file"
		}
		targets[root.ID] = kind
	}
	for _, folder := range listing.folders {
		targets[folder] = "directory"
	}
	for _, file := range listing.files {
		_, root, err := a.documentCandidate(file, true)
		if err != nil || root.IsFile {
			continue
		}
		targets[file] = "file"
	}
	for _, rule := range policy.Permissions.Rules {
		kind := "file"
		if rule.Directory {
			kind = "directory"
		}
		targets[a.permissionPath(rule.Path)] = kind
	}
	type target struct {
		Path string `json:"path"`
		Kind string `json:"kind"`
	}
	options := []target{}
	for path, kind := range targets {
		options = append(options, target{path, kind})
	}
	sort.Slice(options, func(i, j int) bool { return options[i].Path < options[j].Path })
	writeJSON(w, 200, struct {
		permissionConfig
		Revision string   `json:"config_revision"`
		Targets  []target `json:"targets"`
	}{permissions, state.Revision, options})
}
