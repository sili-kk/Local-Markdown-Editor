package main

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var finalPathByHandle = syscall.NewLazyDLL("kernel32.dll").NewProc("GetFinalPathNameByHandleW")

// Resolve the actual opened target, including junctions/reparse points that
// filepath.EvalSymlinks may classify differently from ordinary symlinks.
func resolveFilesystemPath(path string) (string, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	handle, err := syscall.CreateFile(name, 0, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", &os.PathError{Op: "resolve", Path: path, Err: err}
	}
	defer syscall.CloseHandle(handle)
	buffer := make([]uint16, 512)
	for {
		length, _, callErr := finalPathByHandle.Call(uintptr(handle), uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), 0)
		if length == 0 {
			return "", &os.PathError{Op: "resolve", Path: path, Err: callErr}
		}
		if length >= uintptr(len(buffer)) {
			buffer = make([]uint16, length+1)
			continue
		}
		resolved := syscall.UTF16ToString(buffer[:length])
		if strings.HasPrefix(resolved, `\\?\UNC\`) {
			resolved = `\\` + strings.TrimPrefix(resolved, `\\?\UNC\`)
		} else {
			resolved = strings.TrimPrefix(resolved, `\\?\`)
		}
		return filepath.Clean(resolved), nil
	}
}
