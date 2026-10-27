package main

import "sync"

type documentLock struct {
	mu    sync.RWMutex
	users int
}

// Readers of the same document can run together. Its revision check and file
// replacement hold the write lock, including on Windows where open readers
// can prevent replacement. Reference counts include queued requests so lock
// entries are reclaimed only after the last user has released them.
func (a *application) lockDocument(path string, write bool) func() {
	key := directoryKey(path)
	a.fileLocksMu.Lock()
	if a.fileLocks == nil {
		a.fileLocks = make(map[string]*documentLock)
	}
	lock := a.fileLocks[key]
	if lock == nil {
		lock = &documentLock{}
		a.fileLocks[key] = lock
	}
	lock.users++
	a.fileLocksMu.Unlock()
	if write {
		lock.mu.Lock()
	} else {
		lock.mu.RLock()
	}
	return func() {
		if write {
			lock.mu.Unlock()
		} else {
			lock.mu.RUnlock()
		}
		a.fileLocksMu.Lock()
		lock.users--
		if lock.users == 0 {
			delete(a.fileLocks, key)
		}
		a.fileLocksMu.Unlock()
	}
}
