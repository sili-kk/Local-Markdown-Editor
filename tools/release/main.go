// Build self-contained release archives without external archive programs.
package main

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type entry struct {
	path string
	data []byte
	mode int64
}

func main() {
	version := flag.String("version", "v0.1.0", "version, for example v0.1.0")
	out := flag.String("out", "dist", "output directory")
	flag.Parse()
	if !regexp.MustCompile(`^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`).MatchString(*version) {
		panic("version must have the form v1.2.3 or v1.2.3-rc.1")
	}
	if err := build(*version, *out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func build(version, out string) error {
	if _, err := os.Stat("go.mod"); err != nil {
		return fmt.Errorf("run from the repository root: %w", err)
	}
	if err := os.MkdirAll(out, 0755); err != nil {
		return err
	}
	common := []entry{}
	for _, name := range []string{"README.md", "README.en.md", "LICENSE", "config.example.yaml", "docs", "third_party"} {
		if err := collect(name, &common); err != nil {
			return err
		}
	}
	for _, vendor := range []string{"toastui/LICENSE", "toastui-table/LICENSE", "diff3/LICENSE.md"} {
		name := "web/vendor/" + vendor
		if err := collect(name, &common); err != nil {
			return err
		}
	}
	checksums := []string{}
	writePackage := func(name string, entries []entry, isZip bool) error {
		archive := filepath.Join(out, name)
		if err := pack(archive, strings.TrimSuffix(strings.TrimSuffix(name, ".tar.gz"), ".zip"), entries, isZip); err != nil {
			return err
		}
		file, err := os.Open(archive)
		if err != nil {
			return err
		}
		hash := sha256.New()
		_, err = io.Copy(hash, file)
		file.Close()
		if err != nil {
			return err
		}
		checksums = append(checksums, hex.EncodeToString(hash.Sum(nil))+"  "+name)
		fmt.Println("created", name)
		return nil
	}
	for _, target := range []struct{ os, arch string }{{"windows", "amd64"}, {"windows", "arm64"}, {"linux", "amd64"}, {"linux", "arm64"}, {"darwin", "amd64"}, {"darwin", "arm64"}} {
		binaryName := "md-editor"
		if target.os == "windows" {
			binaryName += ".exe"
		}
		tmp, err := os.MkdirTemp("", "markdown-release-")
		if err != nil {
			return err
		}
		binary := filepath.Join(tmp, binaryName)
		cmd := exec.Command("go", "build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w -buildid= -X main.buildVersion="+version, "-o", binary, ".")
		cmd.Env = buildEnv(target.os, target.arch)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		err = cmd.Run()
		if err != nil {
			os.RemoveAll(tmp)
			return err
		}
		data, err := os.ReadFile(binary)
		os.RemoveAll(tmp)
		if err != nil {
			return err
		}
		entries := append([]entry{}, common...)
		entries = append(entries, entry{path: binaryName, data: data, mode: 0755})
		ext := ".tar.gz"
		if target.os == "windows" {
			ext = ".zip"
		}
		name := "local-markdown-editor_" + version + "_" + target.os + "_" + target.arch + ext
		if err := writePackage(name, entries, target.os == "windows"); err != nil {
			return err
		}
	}
	// Include corresponding source alongside binaries. Only public export paths
	// are collected; runtime configuration, documents, logs and artifacts are not.
	source := []entry{}
	files, err := filepath.Glob("*.go")
	if err != nil {
		return err
	}
	files = append(files, "go.mod", "go.sum", "README.md", "README.en.md", "LICENSE", "Dockerfile", "docker-compose.yml", "docker-entrypoint.sh", "config.example.yaml", "config.docker.example.yaml", ".gitignore", ".gitattributes", ".dockerignore", ".github", "docs", "scripts", "tests", "tools", "web", "third_party")
	for _, name := range files {
		if err := collect(name, &source); err != nil {
			return err
		}
	}
	if err := writePackage("local-markdown-editor_"+version+"_source.zip", source, true); err != nil {
		return err
	}
	sort.Strings(checksums)
	return os.WriteFile(filepath.Join(out, "SHA256SUMS.txt"), []byte(strings.Join(checksums, "\n")+"\n"), 0644)
}

func buildEnv(goos, goarch string) []string {
	result := []string{}
	for _, value := range os.Environ() {
		name, _, _ := strings.Cut(value, "=")
		switch strings.ToUpper(name) {
		case "GOOS", "GOARCH", "CGO_ENABLED", "GOAMD64", "GOARM64":
			continue
		}
		result = append(result, value)
	}
	return append(result, "GOOS="+goos, "GOARCH="+goarch, "CGO_ENABLED=0", "GOAMD64=v1", "GOARM64=v8.0")
}

func collect(name string, entries *[]entry) error {
	return filepath.Walk(name, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("not a regular release file: %s", path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		mode := int64(0644)
		if strings.HasSuffix(path, ".sh") {
			mode = 0755
		}
		*entries = append(*entries, entry{path: filepath.ToSlash(path), data: data, mode: mode})
		return nil
	})
}

func pack(path, prefix string, entries []entry, isZip bool) (err error) {
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer func() {
		if e := file.Close(); err == nil {
			err = e
		}
	}()
	sort.Slice(entries, func(i, j int) bool { return entries[i].path < entries[j].path })
	timestamp := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if isZip {
		writer := zip.NewWriter(file)
		for _, item := range entries {
			header := &zip.FileHeader{Name: prefix + "/" + item.path, Method: zip.Deflate}
			header.SetMode(os.FileMode(item.mode))
			header.SetModTime(timestamp)
			entry, e := writer.CreateHeader(header)
			if e != nil {
				writer.Close()
				return e
			}
			if _, e = entry.Write(item.data); e != nil {
				writer.Close()
				return e
			}
		}
		return writer.Close()
	}
	gz := gzip.NewWriter(file)
	writer := tar.NewWriter(gz)
	for _, item := range entries {
		header := &tar.Header{Name: prefix + "/" + item.path, Mode: item.mode, Size: int64(len(item.data)), ModTime: timestamp, Typeflag: tar.TypeReg}
		if err := writer.WriteHeader(header); err != nil {
			writer.Close()
			gz.Close()
			return err
		}
		if _, err := writer.Write(item.data); err != nil {
			writer.Close()
			gz.Close()
			return err
		}
	}
	if err := writer.Close(); err != nil {
		gz.Close()
		return err
	}
	return gz.Close()
}
