package main

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

var errOutsideDirectories = errors.New("只允许访问已配置文档目录内的资源")

func requestHostname(r *http.Request) string {
	host := r.Host
	if name, _, err := net.SplitHostPort(host); err == nil {
		host = name
	}
	return strings.TrimSuffix(strings.Trim(strings.ToLower(host), "[]"), ".")
}

// Literal addresses and localhost cannot be rebound through attacker-owned DNS.
// Forwarded headers confer no authority. Custom domains require a separate,
// authenticated reverse proxy design rather than implicit local privileges.
func validRequestHost(r *http.Request) bool {
	host := requestHostname(r)
	if host == "localhost" {
		return true
	}
	_, err := netip.ParseAddr(host)
	return err == nil
}

func (a *application) localAdminRequest(r *http.Request) bool {
	// A forwarded request must never acquire the proxy's loopback privileges.
	for _, header := range []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Real-IP", "Via"} {
		if r.Header.Get(header) != "" {
			return false
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	ip = ip.Unmap().WithZone("")
	if !validRequestHost(r) {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	policy, _ := a.accessSnapshot()
	for _, serverIP := range policy.ServerIPs {
		if serverIP == ip {
			return true
		}
	}
	return false
}

func (a *application) requireLocalAdmin(w http.ResponseWriter, r *http.Request) bool {
	if a.localAdminRequest(r) {
		return true
	}
	writeError(w, http.StatusForbidden, "此操作仅允许服务器本机或 server_ips 中指定的管理来源访问")
	return false
}

func withinDirectories(path string, roots []documentRoot) bool {
	for _, root := range roots {
		if root.IsFile && directoryKey(root.Path) != directoryKey(path) {
			continue
		}
		rel, err := filepath.Rel(root.Path, path)
		if err == nil && filepath.IsLocal(rel) {
			return true
		}
	}
	return false
}

// Check the lexical boundary before touching the filesystem (including UNC
// shares), then check again after resolving symlinks/junctions. Missing resource
// metadata is allowed only when its nearest existing ancestor is confined too.
func confinedPath(path string, roots []documentRoot, allowMissing bool) (string, error) {
	if strings.ContainsRune(path, 0) || !filepath.IsAbs(path) {
		return "", errOutsideDirectories
	}
	if runtime.GOOS == "windows" {
		if strings.HasPrefix(path, `\\?\`) || strings.HasPrefix(path, `\\.\`) || strings.Contains(path[len(filepath.VolumeName(path)):], ":") {
			return "", errOutsideDirectories
		}
	}
	path = filepath.Clean(path)
	if !withinDirectories(path, roots) {
		return "", errOutsideDirectories
	}
	candidate := path
	var missing []string
	for {
		resolved, err := resolveFilesystemPath(candidate)
		if err == nil {
			for i := len(missing) - 1; i >= 0; i-- {
				resolved = filepath.Join(resolved, missing[i])
			}
			if !withinDirectories(resolved, roots) {
				return "", errOutsideDirectories
			}
			return resolved, nil
		}
		if !allowMissing || !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(candidate)
		if parent == candidate {
			return "", errOutsideDirectories
		}
		missing = append(missing, filepath.Base(candidate))
		candidate = parent
	}
}
