package main

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

type browseEntry struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Directory bool   `json:"directory"`
}

type browseResult struct {
	Path      string        `json:"path"`
	Parent    string        `json:"parent"`
	Selected  string        `json:"selected"`
	Entries   []browseEntry `json:"entries"`
	Truncated bool          `json:"truncated"`
}

// Browsing arbitrary server paths is restricted to the same administrators who
// can change docs_dir. No document contents are read and no paths are created.
func (a *application) browseDirectories(w http.ResponseWriter, r *http.Request) {
	if !allowMethod(w, r, http.MethodGet) || !a.requireLocalAdmin(w, r) {
		return
	}
	result := browseResult{Entries: []browseEntry{}}
	if r.URL.Query().Get("roots") == "1" {
		if runtime.GOOS == "windows" {
			for drive := 'A'; drive <= 'Z'; drive++ {
				path := string(drive) + ":\\"
				if info, err := os.Stat(path); err == nil && info.IsDir() {
					result.Entries = append(result.Entries, browseEntry{Name: path, Path: path, Directory: true})
				}
			}
		} else {
			result.Entries = append(result.Entries, browseEntry{Name: "/", Path: "/", Directory: true})
		}
		writeJSON(w, 200, result)
		return
	}
	path := strings.TrimSpace(r.URL.Query().Get("path"))
	if path == "" {
		path = filepath.Dir(a.configPath)
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(filepath.Dir(a.configPath), path)
	}
	path, err := resolveFilesystemPath(path)
	if err != nil {
		writeError(w, 400, "无法打开路径："+err.Error())
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		fileError(w, err)
		return
	}
	result.Selected = path
	if !info.IsDir() {
		if !info.Mode().IsRegular() || !isMarkdown(path) {
			writeError(w, 400, "请选择文件夹或 Markdown 文件")
			return
		}
		path = filepath.Dir(path)
	}
	result.Path, result.Parent = path, filepath.Dir(path)
	if result.Parent == path {
		result.Parent = ""
	}
	dir, err := os.Open(path)
	if err != nil {
		fileError(w, err)
		return
	}
	defer dir.Close()
	// Bound both directory scanning and the browser DOM for very large folders.
	for scanned := 0; ; {
		batch, readErr := dir.ReadDir(256)
		for _, entry := range batch {
			scanned++
			if scanned > 10000 || len(result.Entries) >= 2000 {
				result.Truncated = true
				break
			}
			candidate := filepath.Join(path, entry.Name())
			isDir := entry.IsDir()
			if entry.Type()&os.ModeSymlink != 0 {
				info, err := os.Stat(candidate)
				if err != nil {
					continue
				}
				isDir = info.IsDir()
				if !isDir && !info.Mode().IsRegular() {
					continue
				}
			} else if !isDir && !entry.Type().IsRegular() {
				continue
			}
			if isDir || isMarkdown(candidate) {
				result.Entries = append(result.Entries, browseEntry{Name: entry.Name(), Path: candidate, Directory: isDir})
			}
		}
		if result.Truncated || errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			fileError(w, readErr)
			return
		}
	}
	sort.Slice(result.Entries, func(i, j int) bool {
		left, right := result.Entries[i], result.Entries[j]
		if left.Directory != right.Directory {
			return left.Directory
		}
		return strings.ToLower(left.Name) < strings.ToLower(right.Name)
	})
	writeJSON(w, 200, result)
}
