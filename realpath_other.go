//go:build !windows

package main

import "path/filepath"

func resolveFilesystemPath(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
