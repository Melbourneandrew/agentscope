//go:build !unix

package control

import "os"

func validatePlatformFile(info os.FileInfo, wantDir bool) error { return nil }
func lockFile(file *os.File) error                              { return nil }
func unlockFile(file *os.File) error                            { return nil }
