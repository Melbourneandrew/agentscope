package control

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	maxRuntimeClosureBytes = 768 << 20
	maxRuntimeEntryBytes   = 256 << 20
)

type RuntimeIdentity struct {
	TreeSHA256        string
	NodeSHA256        string
	NPMCLISHA256      string
	WranglerCLISHA256 string
}

func extractRuntimeClosure(archive []byte, destination string, workerLockSHA256 string) (RuntimeIdentity, error) {
	if len(archive) == 0 || len(archive) > maxRuntimeClosureBytes {
		return RuntimeIdentity{}, errors.New("E_RUNTIME_ARCHIVE_BOUNDS")
	}
	gzipReader, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return RuntimeIdentity{}, errors.New("E_RUNTIME_ARCHIVE")
	}
	defer gzipReader.Close()
	reader := tar.NewReader(gzipReader)
	var total int64
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return RuntimeIdentity{}, errors.New("E_RUNTIME_ARCHIVE")
		}
		clean := filepath.Clean(header.Name)
		if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || strings.Contains(clean, "\\") {
			return RuntimeIdentity{}, errors.New("E_RUNTIME_ARCHIVE_PATH")
		}
		first := strings.Split(clean, string(filepath.Separator))[0]
		if first != "node" && first != "coordinator" {
			return RuntimeIdentity{}, errors.New("E_RUNTIME_ARCHIVE_ROOT")
		}
		target := filepath.Join(destination, clean)
		if filepath.Clean(target) == destination || !strings.HasPrefix(filepath.Clean(target), destination+string(filepath.Separator)) {
			return RuntimeIdentity{}, errors.New("E_RUNTIME_ARCHIVE_PATH")
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return RuntimeIdentity{}, err
			}
			if err := os.Chmod(target, 0o700); err != nil {
				return RuntimeIdentity{}, err
			}
		case tar.TypeReg, tar.TypeRegA:
			if header.Size < 0 || header.Size > maxRuntimeEntryBytes || total+header.Size > maxRuntimeClosureBytes {
				return RuntimeIdentity{}, errors.New("E_RUNTIME_ARCHIVE_BOUNDS")
			}
			total += header.Size
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return RuntimeIdentity{}, err
			}
			file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o444)
			if err != nil {
				return RuntimeIdentity{}, err
			}
			if _, err := io.CopyN(file, reader, header.Size); err != nil {
				file.Close()
				return RuntimeIdentity{}, err
			}
			if err := file.Chmod(0o444); err != nil {
				file.Close()
				return RuntimeIdentity{}, err
			}
			if err := file.Sync(); err != nil {
				file.Close()
				return RuntimeIdentity{}, err
			}
			if err := file.Close(); err != nil {
				return RuntimeIdentity{}, err
			}
		default:
			return RuntimeIdentity{}, errors.New("E_RUNTIME_ARCHIVE_SPECIAL_FILE")
		}
	}
	if err := filepath.Walk(destination, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			return os.Chmod(path, 0o555)
		}
		return os.Chmod(path, 0o444)
	}); err != nil {
		return RuntimeIdentity{}, err
	}
	paths := runtimePaths(destination)
	for _, path := range []string{paths.node, paths.npmCLI, paths.wranglerCLI} {
		if err := os.Chmod(path, 0o555); err != nil {
			return RuntimeIdentity{}, errors.New("E_RUNTIME_EXECUTABLE")
		}
	}
	lock, err := os.ReadFile(paths.workerLock)
	if err != nil || SHA256(lock) != workerLockSHA256 {
		return RuntimeIdentity{}, errors.New("E_RUNTIME_LOCK")
	}
	tree, err := runtimeTreeDigest(destination)
	if err != nil {
		return RuntimeIdentity{}, err
	}
	node, err := os.ReadFile(paths.node)
	if err != nil {
		return RuntimeIdentity{}, err
	}
	npm, err := os.ReadFile(paths.npmCLI)
	if err != nil {
		return RuntimeIdentity{}, err
	}
	wrangler, err := os.ReadFile(paths.wranglerCLI)
	if err != nil {
		return RuntimeIdentity{}, err
	}
	return RuntimeIdentity{TreeSHA256: tree, NodeSHA256: SHA256(node), NPMCLISHA256: SHA256(npm), WranglerCLISHA256: SHA256(wrangler)}, nil
}

type protectedRuntimePaths struct {
	node, npmCLI, wranglerCLI, workerRoot, workerLock string
}

func runtimePaths(root string) protectedRuntimePaths {
	return protectedRuntimePaths{
		node:        filepath.Join(root, "node", "bin", "node"),
		npmCLI:      filepath.Join(root, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
		wranglerCLI: filepath.Join(root, "coordinator", "worker", "node_modules", "wrangler", "bin", "wrangler.js"),
		workerRoot:  filepath.Join(root, "coordinator", "worker"),
		workerLock:  filepath.Join(root, "coordinator", "worker", "package-lock.json"),
	}
}

func runtimeTreeDigest(root string) (string, error) {
	var records []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if path == root {
			return nil
		}
		if info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) || info.Mode().Perm()&0o022 != 0 {
			return errors.New("E_RUNTIME_TREE_ENTRY")
		}
		if err := validatePlatformFile(info, info.IsDir()); err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if info.IsDir() {
			records = append(records, fmt.Sprintf("d\x00%s\x00%o", relative, info.Mode().Perm()))
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		records = append(records, fmt.Sprintf("f\x00%s\x00%o\x00%s", relative, info.Mode().Perm(), SHA256(data)))
		return nil
	})
	if err != nil {
		return "", err
	}
	sort.Strings(records)
	return SHA256([]byte(strings.Join(records, "\n") + "\n")), nil
}

func verifyRuntimeClosure(root string, installation Installation) (protectedRuntimePaths, error) {
	if err := validateProtectedReadablePath(root, true); err != nil {
		return protectedRuntimePaths{}, err
	}
	paths := runtimePaths(root)
	for path, digest := range map[string]string{paths.node: installation.NodeSHA256, paths.npmCLI: installation.NPMCLISHA256, paths.wranglerCLI: installation.WranglerCLISHA256, paths.workerLock: installation.ToolchainIdentity.WorkerLockSHA256} {
		if err := verifiedFileDigestBounded(path, digest, maxRuntimeEntryBytes); err != nil {
			return protectedRuntimePaths{}, err
		}
	}
	tree, err := runtimeTreeDigest(root)
	if err != nil || tree != installation.RuntimeTreeSHA256 {
		return protectedRuntimePaths{}, errors.New("E_RUNTIME_TREE_CHANGED")
	}
	return paths, nil
}
