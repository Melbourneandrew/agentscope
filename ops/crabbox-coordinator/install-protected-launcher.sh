#!/bin/sh
set -eu
PATH=/usr/bin:/bin
export PATH
umask 077
unset CDPATH ENV BASH_ENV GIT_DIR GIT_WORK_TREE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM NODE_OPTIONS NPM_CONFIG_USERCONFIG TAR_OPTIONS || true

# Builds and installs only the nonsecret protected control plane. It does not
# log in, read a cloud/provider credential, call a network service, or run
# Wrangler.
if [ "$#" -ne 11 ]; then
  echo "usage: $0 INSTALLATION_ID ENVIRONMENT_ID ACCOUNT_ID HETZNER_PROJECT_ID CRABBOX_SOURCE ADMITTED_GO_ARCHIVE ADMITTED_NODE_ARCHIVE TOOLCHAIN_IDENTITY LIVE_PROFILE TERMINAL_PROFILE TERMINAL_ENTRY_POINT" >&2
  exit 64
fi

installation_id=$1
environment_id=$2
account_id=$3
hetzner_project_id=$4
crabbox_source=$5
admitted_go_archive=$6
admitted_node_archive=$7
toolchain_identity=$8
live_profile=$9
terminal_profile=${10}
terminal_entry_point=${11}

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
if [ -n "$(/usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -C "$repository_root" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "protected launcher: E_DIRTY_REPOSITORY" >&2
  exit 1
fi
launcher_source_commit=$(/usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -C "$repository_root" rev-parse --verify HEAD)
case "$launcher_source_commit" in *[!0-9a-f]*) echo "protected launcher: E_SOURCE_COMMIT" >&2; exit 1 ;; esac
if [ "${#launcher_source_commit}" -ne 40 ]; then
  echo "protected launcher: E_SOURCE_COMMIT" >&2
  exit 1
fi
echo "Protected launcher source commit: $launcher_source_commit"
launcher_source_tree=$(/usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -C "$repository_root" rev-parse --verify "$launcher_source_commit^{tree}")
case "$launcher_source_tree" in *[!0-9a-f]*) echo "protected launcher: E_SOURCE_TREE" >&2; exit 1 ;; esac
if [ "${#launcher_source_tree}" -ne 40 ]; then echo "protected launcher: E_SOURCE_TREE" >&2; exit 1; fi
echo "Protected launcher source tree: $launcher_source_tree"

protected_root="/Library/Application Support/Agentscope/CrabboxControl"
installed_policy="$protected_root/policy/installation.json"
upgrade_predecessor_commit=none
upgrade_mode=0
if sudo /bin/test -e "$protected_root"; then
  if ! sudo /bin/test -d "$protected_root" || sudo /bin/test -L "$protected_root" || ! sudo /bin/test -f "$installed_policy" || sudo /bin/test -L "$installed_policy"; then
    echo "protected launcher: E_UPGRADE_INSTALLED_PATH" >&2
    exit 1
  fi
  installed_source_commit=$(sudo /usr/bin/plutil -extract launcherSourceCommit raw -o - "$installed_policy" 2>/dev/null || true)
  case "$installed_source_commit" in *[!0-9a-f]*) echo "protected launcher: E_UPGRADE_INSTALLED_SOURCE" >&2; exit 1 ;; esac
  if [ "${#installed_source_commit}" -ne 40 ]; then
    echo "protected launcher: E_UPGRADE_INSTALLED_SOURCE" >&2
    exit 1
  fi
  upgrade_predecessor_commit=$installed_source_commit
  if [ "$installed_source_commit" = "$launcher_source_commit" ]; then
    # A crash after publishing the next installation identity deliberately
    # fences the predecessor launcher. Resume the same authenticated
    # generation through the rebuilt candidate; its signed intent proves the
    # predecessor and every replacement identity before another rename.
    upgrade_predecessor_commit=$(sudo /usr/bin/plutil -extract previousLauncherSourceCommit raw -o - "$installed_policy" 2>/dev/null || true)
  fi
  case "$upgrade_predecessor_commit" in *[!0-9a-f]*) echo "protected launcher: E_UPGRADE_PREDECESSOR" >&2; exit 1 ;; esac
  if [ "${#upgrade_predecessor_commit}" -ne 40 ] || [ "$upgrade_predecessor_commit" = "$launcher_source_commit" ] ||
     ! /usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -C "$repository_root" merge-base --is-ancestor "$upgrade_predecessor_commit" "$launcher_source_commit"; then
    echo "protected launcher: E_UPGRADE_PREDECESSOR" >&2
    exit 1
  fi
  upgrade_mode=1
  echo "Protected launcher predecessor commit: $upgrade_predecessor_commit"
fi

bundle_root=$(mktemp -d "${TMPDIR:-/tmp}/agentscope-crabbox-bundles.XXXXXX")
build_root=
bootstrap_path="/Library/Application Support/Agentscope/.agentscope-crabbox-control.bootstrap"
bootstrap_installed=0
cleanup() {
  rm -rf -- "$bundle_root"
  if [ -n "$build_root" ]; then sudo rm -rf -- "$build_root"; fi
  if [ "$bootstrap_installed" -eq 1 ]; then sudo rm -f -- "$bootstrap_path"; fi
}
trap cleanup EXIT HUP INT TERM
/usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 \
  /usr/bin/git -C "$repository_root" bundle create "$bundle_root/launcher.bundle" HEAD
/usr/bin/env -i HOME=/var/empty PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 \
  /usr/bin/git -C "$crabbox_source" bundle create "$bundle_root/crabbox.bundle" v0.46.0
build_root=$(sudo /usr/bin/mktemp -d /private/var/tmp/agentscope-crabbox-launcher.XXXXXX)
sudo /bin/chmod 0700 "$build_root"
sudo /bin/mkdir -m 0700 "$build_root/home" "$build_root/source"
sudo /usr/bin/install -o root -g wheel -m 0400 "$bundle_root/launcher.bundle" "$build_root/launcher.bundle"
sudo /usr/bin/install -o root -g wheel -m 0400 "$bundle_root/crabbox.bundle" "$build_root/crabbox.bundle"
sudo /usr/bin/env -i HOME="$build_root/home" PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git clone --no-checkout "$build_root/launcher.bundle" "$build_root/launcher-repository"
sudo /usr/bin/env -i HOME="$build_root/home" PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git clone --no-checkout "$build_root/crabbox.bundle" "$build_root/crabbox-repository"
if [ "$(sudo /usr/bin/env -i HOME="$build_root/home" PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -C "$build_root/launcher-repository" rev-parse --verify HEAD)" != "$launcher_source_commit" ] ||
   [ "$(sudo /usr/bin/env -i HOME="$build_root/home" PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -C "$build_root/launcher-repository" rev-parse --verify "HEAD^{tree}")" != "$launcher_source_tree" ] ||
   [ "$(sudo /usr/bin/env -i HOME="$build_root/home" PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -C "$build_root/crabbox-repository" rev-parse --verify v0.46.0^{commit})" != "8ba71f913bbe57285ae29af45ef0d8ec6712477d" ]; then
  echo "protected launcher: E_SOURCE_BUNDLE_IDENTITY" >&2
  exit 1
fi
sudo /usr/bin/env -i HOME="$build_root/home" PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -C "$build_root/launcher-repository" archive --format=tar "$launcher_source_commit" | sudo /usr/bin/tar -xf - -C "$build_root/source"
source_root=$build_root/source

# Authenticate the compiler distribution before executing any compiler bytes.
expected_go_archive_sha256=efb87ff28af9a188d0536ef5d42e63dd52ba8263cd7344a993cc48dd11dedb6a
actual_go_archive_sha256=$(shasum -a 256 "$admitted_go_archive" | awk '{print $1}')
if [ "$actual_go_archive_sha256" != "$expected_go_archive_sha256" ]; then
  echo "protected launcher: E_GO_ARCHIVE_DIGEST" >&2
  exit 1
fi
sudo /bin/mkdir -m 0700 "$build_root/go-extract"
sudo /usr/bin/install -o root -g wheel -m 0400 "$admitted_go_archive" "$build_root/go-archive.tar.gz"
if [ "$(sudo /usr/bin/shasum -a 256 "$build_root/go-archive.tar.gz" | /usr/bin/awk '{print $1}')" != "$expected_go_archive_sha256" ]; then
  echo "protected launcher: E_GO_ARCHIVE_COPY" >&2
  exit 1
fi
sudo /usr/bin/tar -xzf "$build_root/go-archive.tar.gz" -C "$build_root/go-extract"
go_root=$build_root/go-extract/go
go_binary=$go_root/bin/go
if ! sudo /bin/test -x "$go_binary" || [ "$(sudo "$go_binary" version)" != "go version go1.26.5 darwin/arm64" ]; then
  echo "protected launcher: E_GO_TOOLCHAIN" >&2
  exit 1
fi

if [ "$(sudo /usr/bin/shasum -a 256 "$source_root/ops/crabbox-coordinator/admission.json" | /usr/bin/awk '{print $1}')" != "947f1c128ca030d89c3e6100ce96a159fc4b045afb36b1cf1ef02276e16e2357" ] ||
   [ "$(sudo /usr/bin/shasum -a 256 "$source_root/ops/crabbox-coordinator/permission-manifest.json" | /usr/bin/awk '{print $1}')" != "b8d01f9fe098abc9a67eeba6ee5f8bd18e0b273bbf5bb7766a72e9acc9d2922f" ]; then
  echo "protected launcher: E_CANONICAL_POLICY_DIGEST" >&2
  exit 1
fi

sudo /usr/bin/env -i HOME="$build_root/home" PATH="$go_root/bin:/usr/bin:/bin" GOTOOLCHAIN=local CGO_ENABLED=0 \
  "$go_binary" -C "$source_root/tools/crabbox-launcher" test ./...
sudo /usr/bin/env -i HOME="$build_root/home" PATH="$go_root/bin:/usr/bin:/bin" GOTOOLCHAIN=local CGO_ENABLED=0 \
  "$go_binary" -C "$source_root/tools/crabbox-launcher" build -trimpath -ldflags="-X github.com/Melbourneandrew/agentscope/tools/crabbox-launcher/internal/control.BuildSourceCommit=$launcher_source_commit -X github.com/Melbourneandrew/agentscope/tools/crabbox-launcher/internal/control.BuildSourceTree=$launcher_source_tree -X github.com/Melbourneandrew/agentscope/tools/crabbox-launcher/internal/control.BuildUpgradePredecessorCommit=$upgrade_predecessor_commit" -o "$build_root/agentscope-crabbox-control" ./cmd/agentscope-crabbox-control

# Prepare a complete nonsecret runtime closure before privilege is acquired.
# The root launcher verifies the exact archive digest, extracts only regular
# files/directories, and never executes this user-writable tree directly.
sudo /bin/mkdir -m 0700 "$build_root/runtime" "$build_root/runtime/node" "$build_root/runtime/coordinator" "$build_root/npm-home" "$build_root/node-extract"
expected_node_archive_sha256=$(/usr/bin/plutil -extract nodeArchiveSha256 raw -o - "$toolchain_identity")
actual_node_archive_sha256=$(shasum -a 256 "$admitted_node_archive" | awk '{print $1}')
if [ "$expected_node_archive_sha256" != "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d" ] || [ "$actual_node_archive_sha256" != "$expected_node_archive_sha256" ]; then
  echo "protected launcher: E_NODE_ARCHIVE_DIGEST" >&2
  exit 1
fi
sudo /usr/bin/install -o root -g wheel -m 0400 "$admitted_node_archive" "$build_root/node-archive.tar.gz"
if [ "$(sudo /usr/bin/shasum -a 256 "$build_root/node-archive.tar.gz" | /usr/bin/awk '{print $1}')" != "$expected_node_archive_sha256" ]; then
  echo "protected launcher: E_NODE_ARCHIVE_COPY" >&2
  exit 1
fi
sudo /usr/bin/tar -xzf "$build_root/node-archive.tar.gz" -C "$build_root/node-extract"
admitted_node_root=$(sudo /usr/bin/find "$build_root/node-extract" -mindepth 1 -maxdepth 1 -type d -print)
if [ -z "$admitted_node_root" ] || [ "$(printf '%s\n' "$admitted_node_root" | wc -l | tr -d ' ')" -ne 1 ] || ! sudo /bin/test -x "$admitted_node_root/bin/node" || ! sudo /bin/test -f "$admitted_node_root/lib/node_modules/npm/bin/npm-cli.js"; then
  echo "protected launcher: E_NODE_TOOLCHAIN" >&2
  exit 1
fi
sudo /usr/bin/env COPYFILE_DISABLE=1 /usr/bin/tar -C "$admitted_node_root" -chf - . | sudo /usr/bin/tar -xf - -C "$build_root/runtime/node"
sudo /usr/bin/env -i HOME="$build_root/home" PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git -C "$build_root/crabbox-repository" archive --format=tar 8ba71f913bbe57285ae29af45ef0d8ec6712477d | sudo /usr/bin/tar -xf - -C "$build_root/runtime/coordinator"
sudo /usr/bin/env -i HOME="$build_root/npm-home" PATH="$build_root/runtime/node/bin:/usr/bin:/bin" \
  "$build_root/runtime/node/bin/node" "$build_root/runtime/node/lib/node_modules/npm/bin/npm-cli.js" \
  ci --prefix "$build_root/runtime/coordinator/worker" --ignore-scripts --no-audit --no-fund
sudo /usr/bin/env COPYFILE_DISABLE=1 /usr/bin/tar -C "$build_root/runtime" -chzf "$build_root/runtime-closure.tar.gz" node coordinator
runtime_closure_sha256=$(sudo /usr/bin/shasum -a 256 "$build_root/runtime-closure.tar.gz" | /usr/bin/awk '{print $1}')
launcher_sha256=$(sudo /usr/bin/shasum -a 256 "$build_root/agentscope-crabbox-control" | /usr/bin/awk '{print $1}')
echo "Protected launcher artifact SHA-256: $launcher_sha256"
echo "Protected runtime closure SHA-256: $runtime_closure_sha256"

if [ "${AGENTSCOPE_CRABBOX_INSTALLER_VERIFY_ONLY:-0}" = "1" ]; then
  echo "Protected launcher installer verification complete; no privileged or cloud mutation performed."
  exit 0
fi

# One no-login identity is the authenticated process-set boundary for the
# credentialed Node/Wrangler child. No other workload may run under this UID.
service_user=_agentscope_crabbox
if ! service_uid=$(id -u "$service_user" 2>/dev/null); then
  if group_record=$(/usr/bin/dscl . -read "/Groups/$service_user" PrimaryGroupID 2>/dev/null); then
    service_uid=${group_record##* }
  else
    service_uid=
    candidate=350
    while [ "$candidate" -le 399 ]; do
      if ! /usr/bin/dscl . -search /Users UniqueID "$candidate" 2>/dev/null | grep -q . && ! /usr/bin/dscl . -search /Groups PrimaryGroupID "$candidate" 2>/dev/null | grep -q .; then
        service_uid=$candidate
        break
      fi
      candidate=$((candidate + 1))
    done
    if [ -z "$service_uid" ]; then echo "protected launcher: E_EXECUTOR_UID" >&2; exit 1; fi
    sudo /usr/bin/dscl . -create "/Groups/$service_user"
    sudo /usr/bin/dscl . -create "/Groups/$service_user" PrimaryGroupID "$service_uid"
  fi
  sudo /usr/bin/dscl . -create "/Users/$service_user"
  sudo /usr/bin/dscl . -create "/Users/$service_user" UniqueID "$service_uid"
  sudo /usr/bin/dscl . -create "/Users/$service_user" PrimaryGroupID "$service_uid"
  sudo /usr/bin/dscl . -create "/Users/$service_user" NFSHomeDirectory /var/empty
  sudo /usr/bin/dscl . -create "/Users/$service_user" UserShell /usr/bin/false
  sudo /usr/bin/dscl . -create "/Users/$service_user" IsHidden 1
fi
case "$service_uid" in ''|*[!0-9]*) echo "protected launcher: E_EXECUTOR_UID" >&2; exit 1 ;; esac
service_gid=$(id -g "$service_user" 2>/dev/null || true)
if [ "$service_gid" != "$service_uid" ]; then echo "protected launcher: E_EXECUTOR_GID" >&2; exit 1; fi
service_home=$(/usr/bin/dscl . -read "/Users/$service_user" NFSHomeDirectory 2>/dev/null || true)
service_shell=$(/usr/bin/dscl . -read "/Users/$service_user" UserShell 2>/dev/null || true)
if [ "$service_home" != "NFSHomeDirectory: /var/empty" ] || [ "$service_shell" != "UserShell: /usr/bin/false" ]; then echo "protected launcher: E_EXECUTOR_PRINCIPAL" >&2; exit 1; fi

sudo install -d -o root -g wheel -m 0755 "/Library/Application Support/Agentscope"
sudo install -o root -g wheel -m 0500 "$build_root/agentscope-crabbox-control" "$bootstrap_path"
bootstrap_installed=1
installed_launcher_sha256=$(sudo shasum -a 256 "$bootstrap_path" | awk '{print $1}')
if [ "$installed_launcher_sha256" != "$launcher_sha256" ]; then
  sudo rm -f -- "$bootstrap_path"
  echo "protected launcher: E_BOOTSTRAP_DIGEST" >&2
  exit 1
fi
bootstrap_command=install
if [ "$upgrade_mode" -eq 1 ]; then bootstrap_command=upgrade; fi
sudo "$bootstrap_path" "$bootstrap_command" \
  --installation-id "$installation_id" \
  --environment-id "$environment_id" \
  --account-id "$account_id" \
  --hetzner-project-id "$hetzner_project_id" \
  --executor-uid "$service_uid" \
  --launcher-source-commit "$launcher_source_commit" \
  --launcher-source-tree "$launcher_source_tree" \
  --admission "$source_root/ops/crabbox-coordinator/admission.json" \
  --permission-manifest "$source_root/ops/crabbox-coordinator/permission-manifest.json" \
  --live-profile "$live_profile" \
  --terminal-profile "$terminal_profile" \
  --terminal-entry-point "$terminal_entry_point" \
  --runtime-closure "$build_root/runtime-closure.tar.gz" \
  --runtime-closure-sha256 "$runtime_closure_sha256" \
  --toolchain-identity "$toolchain_identity"
sudo rm -f -- "$bootstrap_path"
bootstrap_installed=0
