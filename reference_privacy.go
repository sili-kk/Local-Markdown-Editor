package main

import (
	"bytes"
	"errors"
	"html"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"unicode"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// The marker identifies a source spelling, not a capability. Resources still
// pass through the configured-root, canonical-path and per-request ACL checks.
const localReferenceMarker = "__local_ref"

type referenceSpan struct {
	start, end int
	value      string
	html       bool
	autolink   bool
}

var htmlReferenceTag = regexp.MustCompile(`(?is)<[a-z][a-z0-9:-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>`)
var htmlReferenceAttribute = regexp.MustCompile(`(?is)\s(?:href|src|poster|title|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>` + "`" + `]+))`)

func referenceValue(value string) string {
	return html.UnescapeString(string(util.UnescapePunctuations([]byte(value))))
}

func absoluteLocalReference(value string) bool {
	value = strings.TrimSpace(referenceValue(value))
	if decoded, err := url.PathUnescape(value); err == nil {
		value = decoded
	}
	return strings.HasPrefix(strings.ToLower(value), "file:") ||
		strings.HasPrefix(value, `\\`) ||
		(len(value) >= 3 && ((value[0] >= 'a' && value[0] <= 'z') || (value[0] >= 'A' && value[0] <= 'Z')) && value[1] == ':' && (value[2] == '/' || value[2] == '\\')) ||
		(strings.HasPrefix(value, "/") && !strings.HasPrefix(value, "//") && !strings.HasPrefix(value, "/assets/"))
}

// Goldmark destinations point into the input. Verify the shared backing slice
// before using its offset; this avoids searching/replacing identical code or
// prose elsewhere in the document. Fail closed if a future parser copies URLs.
func sourceSpan(source, value []byte) (referenceSpan, error) {
	start := cap(source) - cap(value)
	if len(value) == 0 {
		return referenceSpan{}, nil
	}
	if start < 0 || start+len(value) > len(source) || &source[start] != &value[0] {
		return referenceSpan{}, errors.New("无法安全处理文档引用，请在服务端检查文档")
	}
	return referenceSpan{start: start, end: start + len(value), value: string(value)}, nil
}

func (a *application) documentReferences(source []byte) ([]referenceSpan, error) {
	pc := parser.NewContext()
	node := a.md.Parser().Parse(text.NewReader(source), parser.WithContext(pc))
	spans := map[int]referenceSpan{}
	add := func(value []byte) error {
		if len(value) == 0 || (!absoluteLocalReference(string(value)) && !strings.Contains(string(value), localReferenceMarker+"=")) {
			return nil
		}
		span, err := sourceSpan(source, value)
		if err == nil {
			spans[span.start] = span
		}
		return err
	}
	// Goldmark copies title bytes, so locate a sensitive title only directly
	// after its source-backed destination, never by a document-wide search.
	addTitle := func(destination, title []byte) error {
		if len(title) == 0 || (!absoluteLocalReference(string(title)) && !strings.Contains(string(title), localReferenceMarker+"=")) {
			return nil
		}
		dest, err := sourceSpan(source, destination)
		if err != nil {
			return err
		}
		pos := dest.end
		if pos < len(source) && source[pos] == '>' {
			pos++
		}
		for pos < len(source) && (source[pos] == ' ' || source[pos] == '\t' || source[pos] == '\r' || source[pos] == '\n') {
			pos++
		}
		if pos >= len(source) || !strings.ContainsRune("\"'(", rune(source[pos])) {
			return errors.New("无法安全处理文档引用标题，请在服务端检查文档")
		}
		closer := source[pos]
		if closer == '(' {
			closer = ')'
		}
		start := pos + 1
		for pos = start; pos < len(source); pos++ {
			if source[pos] == '\\' && pos+1 < len(source) {
				pos++
				continue
			}
			if source[pos] == closer {
				spans[start] = referenceSpan{start: start, end: pos, value: string(source[start:pos])}
				return nil
			}
		}
		return errors.New("无法安全处理文档引用标题，请在服务端检查文档")
	}
	addHTML := func(start, end int) {
		fragment := source[start:end]
		for _, tag := range htmlReferenceTag.FindAllIndex(fragment, -1) {
			for _, attr := range htmlReferenceAttribute.FindAllSubmatchIndex(fragment[tag[0]:tag[1]], -1) {
				for group := 2; group < len(attr); group += 2 {
					if attr[group] >= 0 {
						lo, hi := start+tag[0]+attr[group], start+tag[0]+attr[group+1]
						spans[lo] = referenceSpan{start: lo, end: hi, value: string(source[lo:hi]), html: true}
						break
					}
				}
			}
		}
	}
	err := ast.Walk(node, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch n := n.(type) {
		case *ast.Link:
			if err := add(n.Destination); err != nil {
				return ast.WalkStop, err
			}
			if err := addTitle(n.Destination, n.Title); err != nil {
				return ast.WalkStop, err
			}
		case *ast.Image:
			if err := add(n.Destination); err != nil {
				return ast.WalkStop, err
			}
			if err := addTitle(n.Destination, n.Title); err != nil {
				return ast.WalkStop, err
			}
		case *ast.AutoLink:
			value := n.URL(source)
			if absoluteLocalReference(string(value)) {
				span, err := sourceSpan(source, value)
				if err != nil {
					return ast.WalkStop, err
				}
				if span.start == 0 || span.end >= len(source) || source[span.start-1] != '<' || source[span.end] != '>' {
					return ast.WalkStop, errors.New("无法安全处理文档自动链接，请在服务端检查文档")
				}
				span.start--
				span.end++
				span.autolink = true
				spans[span.start] = span
			}
		case *ast.RawHTML:
			if n.Segments.Len() > 0 {
				addHTML(n.Segments.At(0).Start, n.Segments.At(n.Segments.Len()-1).Stop)
			}
		case *ast.HTMLBlock:
			if n.Lines().Len() > 0 {
				end := n.Lines().At(n.Lines().Len() - 1).Stop
				if n.HasClosure() {
					end = n.ClosureLine.Stop
				}
				addHTML(n.Lines().At(0).Start, end)
			}
		}
		return ast.WalkContinue, nil
	})
	if err != nil {
		return nil, err
	}
	for _, ref := range pc.References() {
		if err := add(ref.Destination()); err != nil {
			return nil, err
		}
		if err := addTitle(ref.Destination(), ref.Title()); err != nil {
			return nil, err
		}
	}
	result := make([]referenceSpan, 0, len(spans))
	for _, span := range spans {
		result = append(result, span)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].start < result[j].start })
	return result, nil
}

func rewriteReferences(source []byte, spans []referenceSpan, replace func(referenceSpan) (string, error)) ([]byte, error) {
	var result bytes.Buffer
	previous := 0
	for _, span := range spans {
		value, err := replace(span)
		if err != nil {
			return nil, err
		}
		result.Write(source[previous:span.start])
		result.WriteString(value)
		previous = span.end
	}
	result.Write(source[previous:])
	return result.Bytes(), nil
}

func (a *application) privateReference(r *http.Request, doc, raw string) string {
	id := revision([]byte(raw))
	address := "/assets/__unavailable/" + id
	if path, err := a.resolveResourceRequest(r, doc, referenceValue(raw)); err == nil {
		if virtual := a.virtualPath(path); strings.HasPrefix(virtual, "@") {
			parts := strings.Split(virtual, "/")
			for i := range parts {
				parts[i] = url.PathEscape(parts[i])
			}
			address = "/assets/" + strings.Join(parts, "/")
		}
	}
	return address + "?" + localReferenceMarker + "=" + id
}

func (a *application) remoteDocument(r *http.Request, doc string, source []byte) ([]byte, error) {
	spans, err := a.documentReferences(source)
	if err != nil {
		return nil, err
	}
	cache := map[string]string{}
	return rewriteReferences(source, spans, func(span referenceSpan) (string, error) {
		raw := span.value
		if absoluteLocalReference(raw) {
			value, ok := cache[raw]
			if !ok {
				value = a.privateReference(r, doc, raw)
				cache[raw] = value
			}
			// A root-relative URL is not a CommonMark autolink. Use an explicit
			// link so the editor keeps it editable and save can restore its URL.
			if span.autolink {
				return "[资源](" + value + ")", nil
			}
			return value, nil
		}
		return raw, nil
	})
}

func (a *application) restoreDocumentReferences(r *http.Request, doc string, source, incoming []byte) ([]byte, error) {
	spans, err := a.documentReferences(source)
	if err != nil {
		return nil, err
	}
	originals := map[string]string{}
	for _, span := range spans {
		if absoluteLocalReference(span.value) {
			originals[a.privateReference(r, doc, span.value)] = span.value
		}
	}
	spans, err = a.documentReferences(incoming)
	if err != nil {
		return nil, err
	}
	return rewriteReferences(incoming, spans, func(span referenceSpan) (string, error) {
		raw := span.value
		value := referenceValue(raw)
		if original, ok := originals[value]; ok {
			// Editors may drop angle/quote delimiters around the safe URL. Put
			// them back if the original contains spaces, so a save remains valid.
			previous := byte(0)
			if span.start > 0 {
				previous = incoming[span.start-1]
			}
			if span.html {
				if previous == '"' && strings.ContainsRune(original, '"') || previous == '\'' && strings.ContainsRune(original, '\'') {
					return html.EscapeString(referenceValue(original)), nil
				}
				if previous != '"' && previous != '\'' && strings.ContainsAny(original, " \t\r\n\"'=<>`") {
					return "\"" + html.EscapeString(referenceValue(original)) + "\"", nil
				}
			} else if previous != '<' && previous != '"' && previous != '\'' && strings.IndexFunc(original, unicode.IsSpace) >= 0 {
				return "<" + original + ">", nil
			}
			return original, nil
		}
		if strings.Contains(value, localReferenceMarker+"=") {
			return "", errors.New("资源引用已变化，无法安全恢复；请重新载入或在合并时采用磁盘中的资源链接。网页草稿尚未保存")
		}
		return raw, nil
	})
}
