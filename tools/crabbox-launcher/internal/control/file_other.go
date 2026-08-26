//go:build !unix

package control

import "os"

func validatePlatformFile(info os.FileInfo, wantDir bool) error { return nil }
