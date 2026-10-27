package main

import (
	"net"
	"net/http"
	"net/netip"
	"os"
	"sort"
	"time"
)

const viewerTimeout = 90 * time.Second

// Track tabs separately so closing one tab does not remove other tabs at the
// same IP. Only the socket peer identifies a visitor; proxy headers are ignored.
type viewerKey struct {
	IP      netip.Addr
	Session string
}

type documentViewer struct {
	Path string
	Seen time.Time
}

type viewerGroup struct {
	counts map[netip.Addr]int
}

type viewerPresence struct {
	IP          string   `json:"ip"`
	Documents   []string `json:"documents"`
	Unavailable bool     `json:"unavailable,omitempty"`
}

func (a *application) removeViewerLocked(key viewerKey) {
	viewer, ok := a.viewers[key]
	if !ok {
		return
	}
	delete(a.viewers, key)
	group := a.viewerGroups[viewer.Path]
	if group == nil {
		return
	}
	group.counts[key.IP]--
	if group.counts[key.IP] == 0 {
		delete(group.counts, key.IP)
		a.viewerSnapshot = nil
	}
	if len(group.counts) == 0 {
		delete(a.viewerGroups, viewer.Path)
	}
}

// Cache the global membership, not each document's count. Heartbeats from an
// existing tab do not rebuild it, and multiple tabs at one IP share one entry.
func (a *application) viewerSnapshotLocked() []viewerPresence {
	if a.viewerSnapshot != nil {
		return a.viewerSnapshot
	}
	byIP := make(map[netip.Addr][]string)
	for path, group := range a.viewerGroups {
		for ip := range group.counts {
			if _, ok := byIP[ip]; !ok {
				byIP[ip] = []string{}
			}
			if path != "" {
				byIP[ip] = append(byIP[ip], path)
			}
		}
	}
	addresses := make([]netip.Addr, 0, len(byIP))
	for ip := range byIP {
		addresses = append(addresses, ip)
	}
	sort.Slice(addresses, func(i, j int) bool { return addresses[i].Compare(addresses[j]) < 0 })
	a.viewerSnapshot = make([]viewerPresence, 0, len(addresses))
	for _, ip := range addresses {
		documents := byIP[ip]
		sort.Strings(documents)
		a.viewerSnapshot = append(a.viewerSnapshot, viewerPresence{IP: ip.String(), Documents: documents})
	}
	return a.viewerSnapshot
}

func (a *application) documentViewers(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodPost) {
		return
	}
	var request struct {
		Session string `json:"session"`
		Path    string `json:"path"`
		Action  string `json:"action"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if !decodeJSON(w, r, &request) {
		return
	}
	if len(request.Session) < 16 || len(request.Session) > 80 || (request.Action != "heartbeat" && request.Action != "leave") {
		writeError(w, http.StatusBadRequest, "无效的在线状态请求")
		return
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		writeError(w, http.StatusBadRequest, "无法识别访问 IP")
		return
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		writeError(w, http.StatusBadRequest, "无法识别访问 IP")
		return
	}
	ip = ip.Unmap().WithZone("")
	path := ""
	if request.Action == "heartbeat" && request.Path != "" {
		_, path, err = a.resolveRequest(r, request.Path, true, false)
		if err != nil {
			fileError(w, os.ErrNotExist)
			return
		}
	}
	now := time.Now()
	a.viewersMu.Lock()
	if a.viewers == nil {
		a.viewers = make(map[viewerKey]documentViewer)
		a.viewerGroups = make(map[string]*viewerGroup)
	}
	if !now.Before(a.viewerSweep) {
		for key, viewer := range a.viewers {
			if now.Sub(viewer.Seen) >= viewerTimeout {
				a.removeViewerLocked(key)
			}
		}
		a.viewerSweep = now.Add(time.Second)
	}
	key := viewerKey{IP: ip, Session: request.Session}
	if request.Action == "leave" {
		a.removeViewerLocked(key)
	} else {
		previous, exists := a.viewers[key]
		if !exists || previous.Path != path {
			a.removeViewerLocked(key)
			group := a.viewerGroups[path]
			if group == nil {
				group = &viewerGroup{counts: make(map[netip.Addr]int)}
				a.viewerGroups[path] = group
			}
			if group.counts[ip] == 0 {
				a.viewerSnapshot = nil
			}
			group.counts[ip]++
		}
		a.viewers[key] = documentViewer{Path: path, Seen: now}
	}
	snapshot := a.viewerSnapshotLocked()
	a.viewersMu.Unlock()
	// Resolve each distinct document once, outside the presence lock. Global
	// totals include every IP, while document names still obey request access.
	visible := make(map[string]string)
	ips := make([]string, 0, len(snapshot))
	viewers := make([]viewerPresence, 0, len(snapshot))
	for _, entry := range snapshot {
		viewer := viewerPresence{IP: entry.IP, Documents: []string{}}
		for _, document := range entry.Documents {
			canonical, checked := visible[document]
			if !checked {
				if _, value, err := a.resolveRequest(r, document, true, false); err == nil {
					canonical = value
				}
				visible[document] = canonical
			}
			if canonical == "" {
				viewer.Unavailable = true
			} else {
				viewer.Documents = append(viewer.Documents, canonical)
			}
		}
		ips = append(ips, viewer.IP)
		viewers = append(viewers, viewer)
	}
	writeJSON(w, http.StatusOK, struct {
		IPs     []string         `json:"ips"`
		Self    string           `json:"self"`
		Viewers []viewerPresence `json:"viewers"`
	}{IPs: ips, Self: ip.String(), Viewers: viewers})
}
