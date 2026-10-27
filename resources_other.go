//go:build !windows

package main

import (
	"os/exec"
	"path/filepath"
	"runtime"
)

func resourceRevealCommand(path string, directory bool) *exec.Cmd {
	if runtime.GOOS == "darwin" {
		return exec.Command("open", "-R", path)
	}
	if !directory {
		path = filepath.Dir(path)
	}
	return exec.Command("xdg-open", path)
}

func openResourceFile(path string) error {
	program := "xdg-open"
	if runtime.GOOS == "darwin" {
		program = "open"
	}
	cmd := exec.Command(program, path)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
