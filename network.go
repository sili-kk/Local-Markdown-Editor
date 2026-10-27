package main

import (
	"fmt"
	"net"
	"net/netip"
	"strings"
)

// CIDR host values bind all interfaces of that address family and restrict
// clients to the configured network. Plain hosts retain their bind semantics.
func parseHost(value string) (string, netip.Prefix, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", netip.Prefix{}, fmt.Errorf("host 不能为空")
	}
	if !strings.Contains(value, "/") {
		return value, netip.Prefix{}, nil
	}
	prefix, err := netip.ParsePrefix(value)
	if err != nil || prefix.Addr().Is4In6() {
		return "", netip.Prefix{}, fmt.Errorf("host 网段无效：%q，请使用如 192.0.2.0/24 的 CIDR 格式", value)
	}
	bind := "::"
	if prefix.Addr().Is4() {
		bind = "0.0.0.0"
	}
	return bind, prefix.Masked(), nil
}

func allowedClient(remoteAddr string, network netip.Prefix) bool {
	if !network.IsValid() {
		return true
	}
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		return false
	}
	ip, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	ip = ip.Unmap().WithZone("")
	return ip.IsLoopback() || network.Contains(ip)
}
