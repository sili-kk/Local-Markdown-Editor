package main

import (
	"fmt"
	"net/http"
	"time"
)

func (a *application) publishDocumentEvent(path, event string) {
	a.eventsMu.Lock()
	defer a.eventsMu.Unlock()
	for ch := range a.documentEvents[directoryKey(path)] {
		select {
		case ch <- event:
		default:
		}
	}
}

func (a *application) streamDocumentEvents(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodGet) {
		return
	}
	value := r.URL.Query().Get("path")
	a.mu.RLock()
	path, _, err := a.resolveRequest(r, value, true, false)
	if err != nil {
		a.mu.RUnlock()
		fileError(w, err)
		return
	}
	ch := make(chan string, 1)
	key := directoryKey(path)
	a.eventsMu.Lock()
	if a.documentEvents == nil {
		a.documentEvents = map[string]map[chan string]struct{}{}
	}
	if a.documentEvents[key] == nil {
		a.documentEvents[key] = map[chan string]struct{}{}
	}
	a.documentEvents[key][ch] = struct{}{}
	a.eventsMu.Unlock()
	a.mu.RUnlock()
	defer func() {
		a.eventsMu.Lock()
		delete(a.documentEvents[key], ch)
		if len(a.documentEvents[key]) == 0 {
			delete(a.documentEvents, key)
		}
		a.eventsMu.Unlock()
	}()
	controller := http.NewResponseController(w)
	defer controller.SetWriteDeadline(time.Time{})
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	send := func(event string) bool {
		_ = controller.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if _, err := fmt.Fprintf(w, "event: %s\ndata: {}\n\n", event); err != nil {
			return false
		}
		if err := controller.Flush(); err != nil {
			return false
		}
		_ = controller.SetWriteDeadline(time.Time{})
		return true
	}
	if !send("ready") {
		return
	}
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case event := <-ch:
			send(event)
			return
		case <-ticker.C:
			if _, _, err := a.resolveRequest(r, value, true, false); err != nil {
				send("unavailable")
				return
			}
			if !send("ping") {
				return
			}
		}
	}
}
