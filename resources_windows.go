package main

import (
	"fmt"
	"os/exec"
	"syscall"
	"unsafe"
)

func openResourceFile(path string) error {
	verb, err := syscall.UTF16PtrFromString("open")
	if err != nil {
		return err
	}
	file, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	// ShellExecute uses the file association directly, without a command shell.
	proc := syscall.NewLazyDLL("shell32.dll").NewProc("ShellExecuteW")
	result, _, _ := proc.Call(0, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(file)), 0, 0, 1)
	if result <= 32 {
		return fmt.Errorf("系统错误 %d，请检查文件关联和访问权限", result)
	}
	return nil
}

func resourceRevealCommand(path string, directory bool) *exec.Cmd {
	var cmd *exec.Cmd
	if directory {
		cmd = exec.Command("explorer.exe", path)
	} else {
		cmd = exec.Command("explorer.exe", "/select,", path)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd
}
