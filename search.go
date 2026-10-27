package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"unicode"
)

var errSearchFileSize = errors.New("文件超过 10 MB 检索上限")

type documentMatcher struct {
	pattern []rune
	failure []int
}

func newDocumentMatcher(query string) documentMatcher {
	pattern := []rune(strings.ToLower(query))
	failure := make([]int, len(pattern))
	for i, matched := 1, 0; i < len(pattern); i++ {
		for matched > 0 && pattern[i] != pattern[matched] {
			matched = failure[matched-1]
		}
		if pattern[i] == pattern[matched] {
			matched++
		}
		failure[i] = matched
	}
	return documentMatcher{pattern: pattern, failure: failure}
}

func (matcher documentMatcher) matchFile(ctx context.Context, path string, reader *bufio.Reader) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() {
		return false, errors.New("路径不是普通文档文件")
	}
	if info.Size() > maxDocumentSize {
		return false, errSearchFileSize
	}
	if len(matcher.pattern) == 0 {
		return true, nil
	}
	reader.Reset(io.LimitReader(f, maxDocumentSize+1))
	for matched, processed, bytesRead := 0, 0, 0; ; processed++ {
		if processed%4096 == 0 {
			if err := ctx.Err(); err != nil {
				return false, err
			}
		}
		character, size, err := reader.ReadRune()
		if err == io.EOF {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		bytesRead += size
		if bytesRead > maxDocumentSize {
			return false, errSearchFileSize
		}
		character = unicode.ToLower(character)
		for matched > 0 && character != matcher.pattern[matched] {
			matched = matcher.failure[matched-1]
		}
		if character == matcher.pattern[matched] {
			matched++
		}
		if matched == len(matcher.pattern) {
			return true, nil
		}
	}
}
