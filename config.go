package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// 同时兼容原来的单路径字符串和新的路径列表。
type directoryPaths []string

func (paths *directoryPaths) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind == yaml.ScalarNode && node.Tag == "!!str" {
		*paths = directoryPaths{node.Value}
		return nil
	}
	if node.Kind != yaml.SequenceNode {
		return errors.New("docs_dir 必须是路径字符串或路径列表")
	}
	values := make(directoryPaths, 0, len(node.Content))
	for _, item := range node.Content {
		if item.Kind != yaml.ScalarNode || item.Tag != "!!str" {
			return errors.New("docs_dir 中的每一项都必须是路径字符串")
		}
		values = append(values, item.Value)
	}
	*paths = values
	return nil
}

func normalizeDirectories(paths []string, configPath string) (directoryPaths, error) {
	if len(paths) > 64 {
		return nil, errors.New("请配置 1–64 个文档目录")
	}
	result := make(directoryPaths, 0, len(paths))
	seen := make(map[string]bool)
	for _, value := range paths {
		value = strings.TrimSpace(value)
		if value == "" {
			return nil, errors.New("文档路径不能为空")
		}
		if !filepath.IsAbs(value) {
			value = filepath.Join(filepath.Dir(configPath), value)
		}
		path, err := filepath.Abs(value)
		if err != nil {
			return nil, fmt.Errorf("无效的文档路径 %q: %w", value, err)
		}
		key := directoryKey(path)
		if !seen[key] {
			seen[key] = true
			result = append(result, path)
		}
	}
	return result, nil
}

func readConfigFile(path string) (config, []byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return config{}, nil, fmt.Errorf("读取配置失败: %w", err)
	}
	cfg, err := parseConfig(data, path)
	return cfg, data, err
}

func parseConfig(data []byte, path string) (config, error) {
	cfg := config{Host: "127.0.0.1", Port: 8080, DocsDir: directoryPaths{"./docs"}}
	cfg.Log = logConfig{Dir: "./logs", MaxSizeMB: 10, MaxBackups: 5, MaxAgeDays: 7, Compress: true}
	cfg.Memory = memoryConfig{ServerMB: 256, DocumentMB: 128}
	cfg.configPath = path
	cfg.Permissions.Default = "rw"
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	if err := decoder.Decode(&cfg); err != nil {
		return cfg, fmt.Errorf("解析配置失败: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return cfg, errors.New("配置文件只能包含一个 YAML 文档")
	}
	if cfg.Host == "" || cfg.Port < 1 || cfg.Port > 65535 {
		return cfg, errors.New("host 不能为空，port 必须在 1–65535 之间")
	}
	if _, _, err := parseHost(cfg.Host); err != nil {
		return cfg, err
	}
	if cfg.Memory.ServerMB < 64 || cfg.Memory.ServerMB > 4096 || cfg.Memory.DocumentMB < 16 || cfg.Memory.DocumentMB > 1024 || cfg.Memory.DocumentMB > cfg.Memory.ServerMB {
		return cfg, errors.New("memory.server_mb 必须为 64–4096，memory.document_mb 必须为 16–1024 且不能超过 server_mb")
	}
	var err error
	cfg.DocsDir, err = normalizeDirectories(cfg.DocsDir, path)
	if err != nil {
		return cfg, err
	}
	if strings.TrimSpace(cfg.Log.Dir) == "" || cfg.Log.MaxSizeMB < 1 || cfg.Log.MaxBackups < 1 || cfg.Log.MaxAgeDays < 1 {
		return cfg, errors.New("log.dir 不能为空，日志大小、备份数量和保留天数必须大于 0")
	}
	if !filepath.IsAbs(cfg.Log.Dir) {
		cfg.Log.Dir = filepath.Join(filepath.Dir(path), cfg.Log.Dir)
	}
	cfg.Log.Dir, err = filepath.Abs(cfg.Log.Dir)
	return cfg, err
}

// Preserve unrelated fields and comments when an owner edits one setting.
func patchConfigField(data []byte, key string, value any) ([]byte, error) {
	var node yaml.Node
	if err := yaml.Unmarshal(data, &node); err != nil {
		return nil, err
	}
	if len(node.Content) != 1 || node.Content[0].Kind != yaml.MappingNode {
		return nil, errors.New("配置必须为 YAML 对象")
	}
	var replacement yaml.Node
	if err := replacement.Encode(value); err != nil {
		return nil, err
	}
	mapping := node.Content[0]
	found := false
	for i := 0; i < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == key {
			old := mapping.Content[i+1]
			replacement.HeadComment = old.HeadComment
			replacement.LineComment = old.LineComment
			replacement.FootComment = old.FootComment
			mapping.Content[i+1] = &replacement
			found = true
			break
		}
	}
	if !found {
		mapping.Content = append(mapping.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: key}, &replacement)
	}
	var output bytes.Buffer
	encoder := yaml.NewEncoder(&output)
	encoder.SetIndent(2)
	if err := encoder.Encode(&node); err != nil {
		return nil, err
	}
	return output.Bytes(), encoder.Close()
}

func patchDirectoryConfig(data []byte, paths []string) ([]byte, error) {
	var node yaml.Node
	if err := yaml.Unmarshal(data, &node); err != nil {
		return nil, err
	}
	if len(node.Content) != 1 || node.Content[0].Kind != yaml.MappingNode {
		return nil, errors.New("配置文件必须是 YAML 对象")
	}
	mapping := node.Content[0]
	var target *yaml.Node
	for i := 0; i < len(mapping.Content); i += 2 {
		if mapping.Content[i].Value == "docs_dir" {
			target = mapping.Content[i+1]
			break
		}
	}
	if target == nil {
		target = &yaml.Node{}
		mapping.Content = append(mapping.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: "docs_dir"}, target)
	}
	// 仅更新目录字段，保留端口、日志配置和已有注释。
	*target = yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq", HeadComment: target.HeadComment, LineComment: target.LineComment, FootComment: target.FootComment}
	for _, path := range paths {
		target.Content = append(target.Content, &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: filepath.ToSlash(path)})
	}
	var output bytes.Buffer
	encoder := yaml.NewEncoder(&output)
	encoder.SetIndent(2)
	if err := encoder.Encode(&node); err != nil {
		return nil, err
	}
	if err := encoder.Close(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}
