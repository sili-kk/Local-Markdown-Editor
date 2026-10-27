// loadcheck exercises a running editor. Write mode only accepts .loadcheck-*.md
// fixtures; use an isolated server and document directory for measurements.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type sample struct {
	Endpoint string
	Status   int
	Millis   float64
	Error    string
}

type summary struct {
	Requests int         `json:"requests"`
	Statuses map[int]int `json:"statuses"`
	Failures int         `json:"failures"`
	P50      float64     `json:"p50_ms"`
	P95      float64     `json:"p95_ms"`
	P99      float64     `json:"p99_ms"`
	Maximum  float64     `json:"max_ms"`
	Errors   []string    `json:"error_examples,omitempty"`
}

func summarize(samples []sample) summary {
	result := summary{Requests: len(samples), Statuses: make(map[int]int)}
	latency := make([]float64, 0, len(samples))
	for _, sample := range samples {
		result.Statuses[sample.Status]++
		latency = append(latency, sample.Millis)
		if sample.Error != "" || sample.Status != 200 && sample.Status != 409 {
			result.Failures++
			if len(result.Errors) < 3 {
				result.Errors = append(result.Errors, fmt.Sprintf("%s status=%d %s", sample.Endpoint, sample.Status, sample.Error))
			}
		}
	}
	sort.Float64s(latency)
	if len(latency) > 0 {
		result.P50 = latency[(len(latency)-1)*50/100]
		result.P95 = latency[(len(latency)-1)*95/100]
		result.P99 = latency[(len(latency)-1)*99/100]
		result.Maximum = latency[len(latency)-1]
	}
	return result
}

func main() {
	base := flag.String("url", "http://127.0.0.1:18094", "isolated editor URL")
	mode := flag.String("mode", "users", "users, read, mixed, viewers, render, search, write")
	concurrency := flag.Int("concurrency", 100, "simultaneous simulated users/workers")
	duration := flag.Duration("duration", 15*time.Second, "measurement duration")
	ramp := flag.Duration("ramp", 0, "spread initial user arrivals over this interval (users mode only)")
	distinct := flag.Bool("distinct-ips", false, "bind each worker to a distinct 127/8 loopback IP")
	same := flag.Bool("same-document", false, "all users open the same document")
	events := flag.Bool("events", false, "keep a document SSE stream open per user (users mode only)")
	remote := flag.Bool("remote", false, "exercise remote ACLs using a Via header that removes local privileges")
	output := flag.String("out", "", "JSON result path")
	flag.Parse()
	if *concurrency < 1 || *duration <= 0 || *ramp < 0 || *ramp > 0 && *mode != "users" {
		panic("positive concurrency and duration required")
	}
	if *events && *mode != "users" {
		panic("events requires users mode")
	}
	switch *mode {
	case "users", "read", "mixed", "viewers", "render", "search", "write":
	default:
		panic("unknown mode")
	}
	*base = strings.TrimRight(*base, "/")
	bootstrap, _ := http.NewRequest(http.MethodGet, *base+"/api/files", nil)
	if *remote {
		bootstrap.Header.Set("Via", "loadcheck")
	}
	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(bootstrap)
	if err != nil {
		panic(err)
	}
	var library struct {
		Files []string `json:"files"`
	}
	err = json.NewDecoder(response.Body).Decode(&library)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 {
		panic("cannot read fixture library")
	}
	files := make([]string, 0)
	for _, file := range library.Files {
		if strings.HasPrefix(path.Base(file), ".loadcheck-") && !strings.Contains(file, "large") {
			files = append(files, file)
		}
	}
	if len(files) == 0 {
		panic("no .loadcheck-*.md fixtures found; use an isolated test directory")
	}
	var mu sync.Mutex
	samples := make([]sample, 0)
	start := time.Now()
	deadline := start.Add(*ramp + *duration)
	streamContext, cancelStreams := context.WithDeadline(context.Background(), deadline)
	defer cancelStreams()
	var streamWorkers sync.WaitGroup
	var activeStreams, peakStreams atomic.Int64
	var workers sync.WaitGroup
	for worker := 0; worker < *concurrency; worker++ {
		workers.Add(1)
		go func(worker int) {
			defer workers.Done()
			arrival := start
			if *concurrency > 1 {
				arrival = start.Add(time.Duration(int64(*ramp) * int64(worker) / int64(*concurrency-1)))
			}
			if delay := time.Until(arrival); delay > 0 {
				time.Sleep(delay)
			}
			dialer := &net.Dialer{Timeout: 10 * time.Second}
			if *distinct {
				dialer.LocalAddr = &net.TCPAddr{IP: net.ParseIP(fmt.Sprintf("127.%d.%d.%d", worker/(250*250), worker/250%250, worker%250+2))}
			}
			transport := &http.Transport{DialContext: dialer.DialContext, MaxIdleConnsPerHost: 4, IdleConnTimeout: time.Minute}
			defer transport.CloseIdleConnections()
			client := &http.Client{Transport: transport, Timeout: 35 * time.Second}
			file := files[worker%len(files)]
			if *same {
				file = files[0]
			}
			request := func(endpoint, method, route string, body any) ([]byte, int) {
				var payload []byte
				if body != nil {
					payload, _ = json.Marshal(body)
				}
				req, _ := http.NewRequestWithContext(context.Background(), method, *base+route, bytes.NewReader(payload))
				if *remote {
					req.Header.Set("Via", "loadcheck")
				}
				if body != nil {
					req.Header.Set("Content-Type", "application/json")
				}
				started := time.Now()
				res, err := client.Do(req)
				var data []byte
				status := 0
				if err == nil {
					status = res.StatusCode
					data, err = io.ReadAll(res.Body)
					res.Body.Close()
				}
				entry := sample{Endpoint: endpoint, Status: status, Millis: float64(time.Since(started).Microseconds()) / 1000}
				if err != nil {
					entry.Error = err.Error()
				}
				if status >= 400 && status != 409 {
					entry.Error = string(data)
				}
				mu.Lock()
				samples = append(samples, entry)
				mu.Unlock()
				return data, status
			}
			heartbeat := func() {
				request("viewers", "POST", "/api/viewers", map[string]string{"session": fmt.Sprintf("loadcheck-worker-%016d", worker), "path": file, "action": "heartbeat"})
			}
			read := func() { request("read", "GET", "/api/file?path="+url.QueryEscape(file), nil) }
			if *mode == "users" {
				request("files", "GET", "/api/files", nil)
				read()
				heartbeat()
				if *events {
					streamWorkers.Add(1)
					go func() {
						defer streamWorkers.Done()
						req, _ := http.NewRequestWithContext(streamContext, http.MethodGet, *base+"/api/document-events?path="+url.QueryEscape(file), nil)
						if *remote {
							req.Header.Set("Via", "loadcheck")
						}
						began := time.Now()
						res, err := (&http.Client{Transport: transport}).Do(req)
						entry := sample{Endpoint: "events", Millis: float64(time.Since(began).Microseconds()) / 1000}
						if err != nil {
							entry.Error = err.Error()
						} else {
							entry.Status = res.StatusCode
						}
						mu.Lock()
						samples = append(samples, entry)
						mu.Unlock()
						if err != nil {
							return
						}
						defer res.Body.Close()
						if res.StatusCode != 200 {
							return
						}
						active := activeStreams.Add(1)
						for peak := peakStreams.Load(); active > peak; peak = peakStreams.Load() {
							if peakStreams.CompareAndSwap(peak, active) {
								break
							}
						}
						defer activeStreams.Add(-1)
						_, err = io.Copy(io.Discard, res.Body)
						if streamContext.Err() == nil {
							entry = sample{Endpoint: "events_closed_early", Error: fmt.Sprintf("stream ended before deadline: %v", err)}
							mu.Lock()
							samples = append(samples, entry)
							mu.Unlock()
						}
					}()
				}
				for tick := 1; ; tick++ {
					next := arrival.Add(time.Duration(tick)*5*time.Second + time.Duration(worker%1000)*time.Millisecond)
					if !next.Before(deadline) {
						return
					}
					if delay := time.Until(next); delay > 0 {
						time.Sleep(delay)
					}
					request("files", "GET", "/api/files", nil)
					if tick%3 == 0 {
						heartbeat()
					}
					if tick%6 == 0 {
						request("revision", "GET", "/api/file?revision_only=1&path="+url.QueryEscape(file), nil)
					}
				}
			}
			for operation := worker; time.Now().Before(deadline); operation++ {
				selected := *mode
				if selected == "mixed" {
					selected = []string{"read", "read", "read", "files", "files", "revision", "viewers", "viewers", "render", "search"}[operation%10]
				}
				switch selected {
				case "read":
					read()
				case "files":
					request("files", "GET", "/api/files", nil)
				case "revision":
					request("revision", "GET", "/api/file?revision_only=1&path="+url.QueryEscape(file), nil)
				case "viewers":
					heartbeat()
				case "render":
					request("render", "POST", "/api/render", map[string]string{"content": "# Loadcheck\n\n" + strings.Repeat("A paragraph with **bold** and [link](https://example.com).\n\n", 200)})
				case "search":
					request("search", "GET", "/api/search?q=complete", nil)
				case "write":
					data, code := request("read", "GET", "/api/file?path="+url.QueryEscape(file), nil)
					if code != 200 {
						continue
					}
					var doc struct {
						Content  string `json:"content"`
						Revision string `json:"revision"`
					}
					if json.Unmarshal(data, &doc) != nil {
						continue
					}
					content := strings.Split(doc.Content, "\n<!-- loadcheck worker=")[0] + fmt.Sprintf("\n<!-- loadcheck worker=%d operation=%d -->\n", worker, operation)
					request("save", "PUT", "/api/file", map[string]string{"path": file, "content": content, "revision": doc.Revision})
				}
			}
		}(worker)
	}
	workers.Wait()
	if *mode == "users" {
		if delay := time.Until(deadline); delay > 0 {
			time.Sleep(delay)
		}
	}
	cancelStreams()
	streamWorkers.Wait()
	elapsed := time.Since(start)
	endpoints := make(map[string][]sample)
	for _, sample := range samples {
		endpoints[sample.Endpoint] = append(endpoints[sample.Endpoint], sample)
	}
	byEndpoint := make(map[string]summary)
	for endpoint, subset := range endpoints {
		byEndpoint[endpoint] = summarize(subset)
	}
	result := struct {
		Mode              string             `json:"mode"`
		Concurrency       int                `json:"concurrency"`
		DistinctIPs       bool               `json:"distinct_ips"`
		SameDocument      bool               `json:"same_document"`
		RampSeconds       float64            `json:"ramp_seconds"`
		Seconds           float64            `json:"elapsed_seconds"`
		RequestsPerSecond float64            `json:"requests_per_second"`
		Summary           summary            `json:"summary"`
		Endpoints         map[string]summary `json:"endpoints"`
		EventStreams      bool               `json:"event_streams"`
		RemotePermissions bool               `json:"remote_permissions"`
		PeakStreams       int64              `json:"peak_streams"`
	}{*mode, *concurrency, *distinct, *same, ramp.Seconds(), elapsed.Seconds(), float64(len(samples)) / elapsed.Seconds(), summarize(samples), byEndpoint, *events, *remote, peakStreams.Load()}
	data, _ := json.MarshalIndent(result, "", "  ")
	if *output != "" {
		if err := os.WriteFile(*output, append(data, '\n'), 0600); err != nil {
			panic(err)
		}
	}
	fmt.Println(string(data))
}
