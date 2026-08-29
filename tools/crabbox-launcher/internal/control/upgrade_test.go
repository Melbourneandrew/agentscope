package control

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func (item fixture) upgradeInput(t *testing.T) UpgradeInput {
	t.Helper()
	lock := []byte("locked\n")
	runtimeClosure := runtimeArchive(t, map[string][]byte{
		"node/bin/node": []byte("fake-node"),
		"node/lib/node_modules/npm/bin/npm-cli.js":                 []byte("fake-npm"),
		"coordinator/worker/node_modules/wrangler/bin/wrangler.js": []byte("fake-wrangler"),
		"coordinator/worker/package-lock.json":                     lock,
		"coordinator/worker/src/index.ts":                          []byte("export default {}"),
	})
	admission := []byte(`{"coordinator":{"commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}`)
	manifest := []byte("manifest")
	live := []byte("live-profile")
	terminal := []byte("terminal-profile")
	return UpgradeInput{
		InstallInput: InstallInput{
			skipCanonicalPolicyValidationForTest: true,
			Root:                                 item.store.Root,
			InstallationID:                       item.installation.InstallationID,
			EnvironmentID:                        item.installation.EnvironmentID,
			AccountID:                            item.installation.AccountID,
			HetznerProjectID:                     item.installation.HetznerProjectID,
			CoordinatorCommit:                    item.installation.CoordinatorCommit,
			AdmissionSHA256:                      item.installation.AdmissionSHA256,
			PermissionManifestSHA256:             item.installation.PermissionManifestSHA256,
			LiveProfileSHA256:                    item.installation.LiveProfileSHA256,
			TerminalProfileSHA256:                item.installation.TerminalProfileSHA256,
			Launcher:                             []byte("replacement-launcher"),
			LauncherSourceCommit:                 strings.Repeat("b", 40),
			LauncherSourceTree:                   strings.Repeat("c", 40),
			Admission:                            admission,
			PermissionManifest:                   manifest,
			LiveProfile:                          live,
			TerminalProfile:                      terminal,
			TerminalEntryPoint:                   []byte("terminal-entry"),
			RuntimeClosure:                       runtimeClosure,
			RuntimeClosureSHA256:                 SHA256(runtimeClosure),
			ToolchainIdentity:                    item.toolchain,
			ExecutorUID:                          item.installation.ExecutorUID,
		},
		Now:                            item.now,
		predecessorSourceCommitForTest: item.installation.LauncherSourceCommit,
	}
}

func snapshotTree(t *testing.T, root string, excluded func(string) bool) map[string][]byte {
	t.Helper()
	result := map[string][]byte{}
	if err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		if relative == "." || excluded(relative) {
			if info.IsDir() && relative != "." {
				return filepath.SkipDir
			}
			return nil
		}
		if info.Mode().IsRegular() {
			value, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			result[relative] = append([]byte(nil), value...)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return result
}

func requireSameSnapshot(t *testing.T, before, after map[string][]byte) {
	t.Helper()
	if len(before) != len(after) {
		t.Fatalf("protected snapshot count changed: %d != %d", len(before), len(after))
	}
	for name, expected := range before {
		actual, ok := after[name]
		if !ok || !bytes.Equal(actual, expected) {
			t.Fatalf("protected state changed: %s", name)
		}
	}
}

func TestUpgradePreservesProtectedAuthorityAndRuntime(t *testing.T) {
	item := newFixture(t)
	input := item.upgradeInput(t)
	excluded := func(relative string) bool {
		return relative == "policy/installation.json" || relative == "bin/agentscope-crabbox-control" || relative == "journal/launcher-upgrades"
	}
	before := snapshotTree(t, item.store.Root, excluded)

	upgraded, err := Upgrade(input)
	if err != nil {
		t.Fatal(err)
	}
	if upgraded.SchemaVersion != 2 || upgraded.LauncherGeneration != 2 || upgraded.PreviousLauncherSHA256 != item.installation.LauncherSHA256 || upgraded.PreviousLauncherCommit != item.installation.LauncherSourceCommit || upgraded.LauncherSHA256 != SHA256(input.Launcher) {
		t.Fatalf("unexpected upgraded installation: %+v", upgraded)
	}
	after := snapshotTree(t, item.store.Root, excluded)
	requireSameSnapshot(t, before, after)
	if data, err := readPrivate(item.store.path("bin", "agentscope-crabbox-control")); err != nil || !bytes.Equal(data, input.Launcher) {
		t.Fatalf("replacement launcher not installed: %v", err)
	}
	upgradeRoot := item.store.path("journal", "launcher-upgrades", "000002-"+SHA256(input.Launcher))
	for _, name := range []string{"installation.next", "launcher.next"} {
		if _, err := os.Lstat(filepath.Join(upgradeRoot, name)); !os.IsNotExist(err) {
			t.Fatalf("terminal upgrade retained stage %s: %v", name, err)
		}
	}

	retried, err := Upgrade(input)
	if err != nil {
		t.Fatal(err)
	}
	if retried.LauncherGeneration != upgraded.LauncherGeneration {
		t.Fatal("exact retry advanced launcher generation")
	}
}

func TestUpgradeResumesEveryReplacementCrashPrefix(t *testing.T) {
	for _, test := range []struct {
		name string
		set  func(*UpgradeInput)
	}{
		{name: "after-staging", set: func(input *UpgradeInput) {
			input.afterStagingForTest = func() error { return errors.New("synthetic crash") }
		}},
		{name: "after-installation", set: func(input *UpgradeInput) {
			input.afterInstallationForTest = func() error { return errors.New("synthetic crash") }
		}},
		{name: "after-launcher", set: func(input *UpgradeInput) {
			input.afterLauncherForTest = func() error { return errors.New("synthetic crash") }
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			item := newFixture(t)
			input := item.upgradeInput(t)
			test.set(&input)
			if _, err := Upgrade(input); err == nil || err.Error() != "synthetic crash" {
				t.Fatalf("crash prefix not reached: %v", err)
			}
			input.afterStagingForTest = nil
			input.afterInstallationForTest = nil
			input.afterLauncherForTest = nil
			upgraded, err := Upgrade(input)
			if err != nil {
				t.Fatal(err)
			}
			if upgraded.LauncherGeneration != 2 || upgraded.LauncherSHA256 != SHA256(input.Launcher) {
				t.Fatalf("upgrade did not converge: %+v", upgraded)
			}
		})
	}
}

func TestUpgradeRejectsDriftAndActiveMutationBeforeReplacement(t *testing.T) {
	tests := []struct {
		name string
		edit func(fixture, *UpgradeInput)
		code string
	}{
		{name: "identity", edit: func(_ fixture, input *UpgradeInput) { input.AccountID = "other-account" }, code: "E_UPGRADE_IDENTITY"},
		{name: "predecessor", edit: func(_ fixture, input *UpgradeInput) { input.predecessorSourceCommitForTest = strings.Repeat("d", 40) }, code: "E_UPGRADE_PREDECESSOR"},
		{name: "runtime", edit: func(_ fixture, input *UpgradeInput) {
			input.RuntimeClosure = runtimeArchive(t, map[string][]byte{
				"node/bin/node": []byte("different-node"),
				"node/lib/node_modules/npm/bin/npm-cli.js":                 []byte("fake-npm"),
				"coordinator/worker/node_modules/wrangler/bin/wrangler.js": []byte("fake-wrangler"),
				"coordinator/worker/package-lock.json":                     []byte("locked\n"),
			})
			input.RuntimeClosureSHA256 = SHA256(input.RuntimeClosure)
		}, code: "E_UPGRADE_RUNTIME_DRIFT"},
		{name: "active-mutation", edit: func(item fixture, _ *UpgradeInput) {
			if err := writeExclusive(item.store.path("journal", "mutation.lock"), []byte(strings.Repeat("e", 64)+"\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		}, code: "E_MUTATION_FENCE"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			item := newFixture(t)
			input := item.upgradeInput(t)
			test.edit(item, &input)
			installationBefore, err := os.ReadFile(item.store.path("policy", "installation.json"))
			if err != nil {
				t.Fatal(err)
			}
			launcherBefore, err := os.ReadFile(item.store.path("bin", "agentscope-crabbox-control"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := Upgrade(input); err == nil || err.Error() != test.code {
				t.Fatalf("got %v, want %s", err, test.code)
			}
			installationAfter, _ := os.ReadFile(item.store.path("policy", "installation.json"))
			launcherAfter, _ := os.ReadFile(item.store.path("bin", "agentscope-crabbox-control"))
			if !bytes.Equal(installationBefore, installationAfter) || !bytes.Equal(launcherBefore, launcherAfter) {
				t.Fatal("rejected upgrade replaced protected identity or launcher")
			}
		})
	}
}

func TestUpgradeRejectsSignedIntentSubstitution(t *testing.T) {
	item := newFixture(t)
	input := item.upgradeInput(t)
	input.afterInstallationForTest = func() error { return errors.New("synthetic crash") }
	if _, err := Upgrade(input); err == nil {
		t.Fatal("expected synthetic crash")
	}
	intentPath := item.store.path("journal", "launcher-upgrades", "000002-"+SHA256(input.Launcher), "intent.json")
	intent, err := os.ReadFile(intentPath)
	if err != nil {
		t.Fatal(err)
	}
	intent = bytes.Replace(intent, []byte(input.LauncherSourceTree), []byte(strings.Repeat("d", 40)), 1)
	if err := os.WriteFile(intentPath, intent, 0o600); err != nil {
		t.Fatal(err)
	}
	input.afterInstallationForTest = nil
	if _, err := Upgrade(input); err == nil || err.Error() != "E_UPGRADE_RECORD" {
		t.Fatalf("substituted intent accepted: %v", err)
	}
}

func TestUpgradeRequiresDurableGenerationDirectoriesBeforeReplacement(t *testing.T) {
	for _, test := range []struct {
		name   string
		failAt int
	}{
		{name: "upgrade-root-parent", failAt: 2},
		{name: "generation-parent", failAt: 4},
	} {
		t.Run(test.name, func(t *testing.T) {
			item := newFixture(t)
			input := item.upgradeInput(t)
			installationBefore, err := os.ReadFile(item.store.path("policy", "installation.json"))
			if err != nil {
				t.Fatal(err)
			}
			launcherBefore, err := os.ReadFile(item.store.path("bin", "agentscope-crabbox-control"))
			if err != nil {
				t.Fatal(err)
			}
			var synced []string
			input.syncDirectoryForTest = func(path string) error {
				synced = append(synced, path)
				if len(synced) == test.failAt {
					return errors.New("synthetic directory sync failure")
				}
				return nil
			}
			if _, err := Upgrade(input); err == nil || err.Error() != "synthetic directory sync failure" {
				t.Fatalf("directory sync failure did not stop upgrade: %v", err)
			}
			upgradeRoot := item.store.path("journal", "launcher-upgrades")
			generationRoot := filepath.Join(upgradeRoot, "000002-"+SHA256(input.Launcher))
			expected := []string{upgradeRoot, item.store.path("journal"), generationRoot, upgradeRoot}
			if len(synced) != test.failAt || !slices.Equal(synced, expected[:test.failAt]) {
				t.Fatalf("upgrade directories were not synced child-before-parent: %v", synced)
			}
			installationAfter, _ := os.ReadFile(item.store.path("policy", "installation.json"))
			launcherAfter, _ := os.ReadFile(item.store.path("bin", "agentscope-crabbox-control"))
			if !bytes.Equal(installationBefore, installationAfter) || !bytes.Equal(launcherBefore, launcherAfter) {
				t.Fatal("directory sync failure replaced protected identity or launcher")
			}
		})
	}
}

func TestEnsureUpgradeDirectoryRejectsExistingPathWithoutMutation(t *testing.T) {
	for _, test := range []struct {
		name  string
		setup func(*testing.T, string) (string, os.FileMode)
	}{
		{name: "symlink", setup: func(t *testing.T, path string) (string, os.FileMode) {
			target := filepath.Join(filepath.Dir(path), "unrelated")
			if err := os.Mkdir(target, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, path); err != nil {
				t.Fatal(err)
			}
			return target, 0o755
		}},
		{name: "regular-file", setup: func(t *testing.T, path string) (string, os.FileMode) {
			if err := os.WriteFile(path, []byte("unrelated"), 0o644); err != nil {
				t.Fatal(err)
			}
			return path, 0o644
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			parent := t.TempDir()
			path := filepath.Join(parent, "launcher-upgrades")
			target, expectedMode := test.setup(t, path)
			before, err := os.ReadFile(target)
			if err != nil && test.name != "symlink" {
				t.Fatal(err)
			}
			if err := ensureUpgradeDirectory(path, func(string) error { return nil }); err == nil {
				t.Fatal("unsafe existing path accepted")
			}
			info, err := os.Lstat(target)
			if err != nil || info.Mode().Perm() != expectedMode {
				t.Fatalf("target mode changed through rejected path: %v %o", err, info.Mode().Perm())
			}
			if test.name != "symlink" {
				after, err := os.ReadFile(target)
				if err != nil || !bytes.Equal(before, after) {
					t.Fatal("rejected existing file content changed")
				}
			}
		})
	}
}
