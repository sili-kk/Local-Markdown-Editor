package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// Permanent regression coverage for global presence, tab lifecycle and access.
type presenceResponse struct {
	IPs     []string         `json:"ips"`
	Self    string           `json:"self"`
	Viewers []viewerPresence `json:"viewers"`
}

func presenceFixture(t *testing.T) (*application, string, string) {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{"one.md", "two.md", "secret.md"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	roots, err := prepareDirectories([]string{dir}, false)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := prepareAccess(config{Permissions: permissionConfig{Default: "r", Rules: []pathPermission{{Path: filepath.Join(dir, "secret.md"), Access: "none"}}}}, roots)
	if err != nil {
		t.Fatal(err)
	}
	return &application{roots: roots, policy: policy}, roots[0].ID, dir
}

func presenceRequest(t *testing.T, app *application, ip, session, path, action string) (int, presenceResponse) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"session": session, "path": path, "action": action})
	r := httptest.NewRequest(http.MethodPost, "/api/viewers", strings.NewReader(string(body)))
	r.Header.Set("Content-Type", "application/json")
	r.Host = "localhost"
	r.RemoteAddr = netip.AddrPortFrom(netip.MustParseAddr(ip), 12345).String()
	w := httptest.NewRecorder()
	app.documentViewers(w, r)
	var response presenceResponse
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
	}
	return w.Code, response
}

func TestGlobalViewerCountsAndDocuments(t *testing.T) {
	app, root, _ := presenceFixture(t)
	const first, second = "192.0.2.1", "192.0.2.2"
	check := func(ip, session, path, action string) presenceResponse {
		t.Helper()
		code, response := presenceRequest(t, app, ip, session, path, action)
		if code != 200 {
			t.Fatalf("presence status %d", code)
		}
		return response
	}
	check(first, "first-tab-session", root+"/one.md", "heartbeat")
	r := check(second, "second-tab-session", root+"/two.md", "heartbeat")
	if !reflect.DeepEqual(r.IPs, []string{first, second}) || r.Self != second {
		t.Fatalf("different documents must share global count: %+v", r)
	}
	r = check(first, "another-tab-session", root+"/two.md", "heartbeat")
	if len(r.IPs) != 2 || !reflect.DeepEqual(r.Viewers[0].Documents, []string{root + "/one.md", root + "/two.md"}) {
		t.Fatalf("one IP with two documents: %+v", r)
	}
	check(first, "duplicate-tab-session", root+"/one.md", "heartbeat")
	r = check(first, "first-tab-session", "", "leave")
	if len(r.Viewers[0].Documents) != 2 {
		t.Fatal("closing one tab must preserve another tab on the same document")
	}
	r = check(first, "duplicate-tab-session", root+"/two.md", "heartbeat")
	if !reflect.DeepEqual(r.Viewers[0].Documents, []string{root + "/two.md"}) {
		t.Fatalf("document switch did not update activity: %+v", r)
	}
	r = check(first, "another-tab-session", "", "heartbeat")
	if len(r.IPs) != 2 || len(r.Viewers[0].Documents) != 1 {
		t.Fatal("empty-document tab must not remove other active documents")
	}
	check(first, "duplicate-tab-session", "", "leave")
	r = check(first, "another-tab-session", "", "heartbeat")
	if len(r.IPs) != 2 || len(r.Viewers[0].Documents) != 0 {
		t.Fatal("connected empty view should still show the global online count")
	}
	r = check(second, "second-tab-session", "", "leave")
	if !reflect.DeepEqual(r.IPs, []string{first}) {
		t.Fatalf("leave did not remove the last tab at an IP: %+v", r)
	}
	r = check(first, "another-tab-session", "", "leave")
	if r.IPs == nil || len(r.IPs) != 0 || r.Viewers == nil || len(r.Viewers) != 0 {
		t.Fatalf("empty presence should return JSON arrays: %+v", r)
	}
}

func TestViewerDetailsRespectPermissionsAndExpiry(t *testing.T) {
	app, root, dir := presenceFixture(t)
	presenceRequest(t, app, "127.0.0.1", "private-tab-session", root+"/secret.md", "heartbeat")
	code, response := presenceRequest(t, app, "192.0.2.2", "public-tab-session", root+"/one.md", "heartbeat")
	if code != 200 || len(response.IPs) != 2 {
		t.Fatalf("global totals missing private-document viewer: %+v", response)
	}
	encoded, _ := json.Marshal(response)
	if strings.Contains(string(encoded), "secret.md") || strings.Contains(string(encoded), dir) {
		t.Fatal("presence leaked a hidden document or absolute path")
	}
	if !response.Viewers[0].Unavailable || len(response.Viewers[0].Documents) != 0 {
		t.Fatal("restricted activity must have an anonymous placeholder")
	}
	if code, _ := presenceRequest(t, app, "192.0.2.3", "denied-tab-session", root+"/secret.md", "heartbeat"); code != 404 {
		t.Fatal("hidden document cannot register a heartbeat")
	}
	_, local := presenceRequest(t, app, "127.0.0.1", "private-tab-session", root+"/secret.md", "heartbeat")
	if !reflect.DeepEqual(local.Viewers[0].Documents, []string{root + "/secret.md"}) {
		t.Fatal("local administrator should see permitted activity")
	}
	// Expiry is driven by the next heartbeat, without waiting 90 real seconds.
	app.viewersMu.Lock()
	key := viewerKey{IP: netip.MustParseAddr("127.0.0.1"), Session: "private-tab-session"}
	entry := app.viewers[key]
	entry.Seen = time.Now().Add(-viewerTimeout - time.Second)
	app.viewers[key] = entry
	app.viewerSweep = time.Time{}
	app.viewersMu.Unlock()
	_, response = presenceRequest(t, app, "192.0.2.2", "public-tab-session", root+"/one.md", "heartbeat")
	if !reflect.DeepEqual(response.IPs, []string{"192.0.2.2"}) {
		t.Fatalf("expired tab remained in global totals: %+v", response)
	}
	if err := os.Remove(filepath.Join(dir, "one.md")); err != nil {
		t.Fatal(err)
	}
	_, response = presenceRequest(t, app, "192.0.2.3", "empty-tab-session", "", "heartbeat")
	if !response.Viewers[0].Unavailable || len(response.Viewers[0].Documents) != 0 {
		t.Fatal("deleted document should not be exposed as an active readable path")
	}
}

func TestConcurrentGlobalViewerSessions(t *testing.T) {
	app, root, _ := presenceFixture(t)
	var workers sync.WaitGroup
	for i := 0; i < 40; i++ {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			ip := fmt.Sprintf("192.0.2.%d", i%10+1)
			presenceRequest(t, app, ip, fmt.Sprintf("parallel-tab-%016d", i), root+"/one.md", "heartbeat")
		}(i)
	}
	workers.Wait()
	_, response := presenceRequest(t, app, "192.0.2.1", "final-tab-session", root+"/two.md", "heartbeat")
	if len(response.IPs) != 10 || len(response.Viewers[0].Documents) != 2 {
		t.Fatalf("concurrent sessions should deduplicate by IP: %+v", response)
	}
}
