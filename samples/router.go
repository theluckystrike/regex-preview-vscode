package router

import (
	"regexp"
)

var (
	routeRe   = regexp.MustCompile(`^/api/v(?P<version>\d+)/(?P<resource>[a-z]+)(?:/(?P<id>[0-9a-f-]{36}))?$`)
	versionRe = regexp.MustCompile("^v(\\d+)\\.(\\d+)\\.(\\d+)$")
	hexColor  = regexp.MustCompile(`#(?:[0-9a-fA-F]{3}){1,2}\b`)
)

// Match returns the route parts.
func Match(path string) map[string]string {
	m := routeRe.FindStringSubmatch(path)
	if m == nil {
		return nil
	}
	out := map[string]string{}
	for i, name := range routeRe.SubexpNames() {
		if name != "" {
			out[name] = m[i]
		}
	}
	return out
}
