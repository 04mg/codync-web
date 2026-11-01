// Package ui holds the built web app (`make ui` writes it to dist/), embedded in the binary.
package ui

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// FS is the app's files, rooted at dist/.
func FS() fs.FS {
	sub, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // dist/ is embedded at build time; fs.Sub can't fail on it
	}
	return sub
}

// Built reports whether the app is inside this build.
func Built() bool {
	_, err := fs.Stat(FS(), "index.html")
	return err == nil
}
