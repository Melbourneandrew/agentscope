#!/bin/sh
set -eu

# Builds and installs only the nonsecret protected control plane. It does not
# log in, read a cloud/provider credential, call a network service, or run
# Wrangler.
if [ "$#" -ne 10 ]; then
  echo "usage: $0 INSTALLATION_ID ENVIRONMENT_ID ACCOUNT_ID HETZNER_PROJECT_ID CRABBOX_SOURCE ADMITTED_NODE_ARCHIVE TOOLCHAIN_IDENTITY LIVE_PROFILE TERMINAL_PROFILE TERMINAL_ENTRY_POINT" >&2
  exit 64
fi

installation_id=$1
environment_id=$2
account_id=$3
hetzner_project_id=$4
crabbox_source=$5
admitted_node_archive=$6
toolchain_identity=$7
live_profile=$8
terminal_profile=$9
terminal_entry_point=${10}

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
go_root=/Users/andrewmelbourne/.local/share/agentscope-crabbox/toolchains/go1.26.5-darwin-arm64
go_binary=$go_root/bin/go

if [ -n "$(git -C "$repository_root" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "protected launcher: E_DIRTY_REPOSITORY" >&2
  exit 1
fi
launcher_source_commit=$(git -C "$repository_root" rev-parse --verify HEAD)
case "$launcher_source_commit" in *[!0-9a-f]*) echo "protected launcher: E_SOURCE_COMMIT" >&2; exit 1 ;; esac
if [ "${#launcher_source_commit}" -ne 40 ]; then
  echo "protected launcher: E_SOURCE_COMMIT" >&2
  exit 1
fi
echo "Protected launcher source commit: $launcher_source_commit"

if [ ! -x "$go_binary" ] || [ "$($go_binary version)" != "go version go1.26.5 darwin/arm64" ]; then
  echo "protected launcher: E_GO_TOOLCHAIN" >&2
  exit 1
fi

build_root=$(mktemp -d "${TMPDIR:-/tmp}/agentscope-crabbox-launcher.XXXXXX")
mkdir -m 0700 "$build_root/home"
bootstrap_path="/Library/Application Support/Agentscope/.agentscope-crabbox-control.bootstrap"
bootstrap_installed=0
cleanup() {
  rm -rf -- "$build_root"
  if [ "$bootstrap_installed" -eq 1 ]; then sudo rm -f -- "$bootstrap_path"; fi
}
trap cleanup EXIT HUP INT TERM

(
  cd "$repository_root/tools/crabbox-launcher"
  env -i HOME="$build_root/home" PATH="$go_root/bin:/usr/bin:/bin" GOTOOLCHAIN=local CGO_ENABLED=0 \
    "$go_binary" test ./...
  env -i HOME="$build_root/home" PATH="$go_root/bin:/usr/bin:/bin" GOTOOLCHAIN=local CGO_ENABLED=0 \
    "$go_binary" build -trimpath -buildvcs=true -o "$build_root/agentscope-crabbox-control" ./cmd/agentscope-crabbox-control
)

# Prepare a complete nonsecret runtime closure before privilege is acquired.
# The root launcher verifies the exact archive digest, extracts only regular
# files/directories, and never executes this user-writable tree directly.
mkdir -m 0700 "$build_root/runtime" "$build_root/runtime/node" "$build_root/runtime/coordinator" "$build_root/npm-home" "$build_root/node-extract"
expected_node_archive_sha256=$(/usr/bin/plutil -extract nodeArchiveSha256 raw -o - "$toolchain_identity")
actual_node_archive_sha256=$(shasum -a 256 "$admitted_node_archive" | awk '{print $1}')
if [ "$actual_node_archive_sha256" != "$expected_node_archive_sha256" ]; then
  echo "protected launcher: E_NODE_ARCHIVE_DIGEST" >&2
  exit 1
fi
tar -xzf "$admitted_node_archive" -C "$build_root/node-extract"
admitted_node_root=$(find "$build_root/node-extract" -mindepth 1 -maxdepth 1 -type d -print)
if [ -z "$admitted_node_root" ] || [ "$(printf '%s\n' "$admitted_node_root" | wc -l | tr -d ' ')" -ne 1 ] || [ ! -x "$admitted_node_root/bin/node" ] || [ ! -f "$admitted_node_root/lib/node_modules/npm/bin/npm-cli.js" ]; then
  echo "protected launcher: E_NODE_TOOLCHAIN" >&2
  exit 1
fi
(cd "$admitted_node_root" && COPYFILE_DISABLE=1 tar -chf - .) | (cd "$build_root/runtime/node" && tar -xf -)
git -C "$crabbox_source" archive --format=tar 8ba71f913bbe57285ae29af45ef0d8ec6712477d | (cd "$build_root/runtime/coordinator" && tar -xf -)
(
  cd "$build_root/runtime/coordinator/worker"
  env -i HOME="$build_root/npm-home" PATH="$build_root/runtime/node/bin:/usr/bin:/bin" \
    "$build_root/runtime/node/bin/node" "$build_root/runtime/node/lib/node_modules/npm/bin/npm-cli.js" \
    ci --ignore-scripts --no-audit --no-fund
)
(cd "$build_root/runtime" && COPYFILE_DISABLE=1 tar -chzf "$build_root/runtime-closure.tar.gz" node coordinator)
runtime_closure_sha256=$(shasum -a 256 "$build_root/runtime-closure.tar.gz" | awk '{print $1}')
launcher_sha256=$(shasum -a 256 "$build_root/agentscope-crabbox-control" | awk '{print $1}')
echo "Protected launcher artifact SHA-256: $launcher_sha256"
echo "Protected runtime closure SHA-256: $runtime_closure_sha256"

sudo install -d -o root -g wheel -m 0755 "/Library/Application Support/Agentscope"
sudo install -o root -g wheel -m 0500 "$build_root/agentscope-crabbox-control" "$bootstrap_path"
bootstrap_installed=1
installed_launcher_sha256=$(sudo shasum -a 256 "$bootstrap_path" | awk '{print $1}')
if [ "$installed_launcher_sha256" != "$launcher_sha256" ]; then
  sudo rm -f -- "$bootstrap_path"
  echo "protected launcher: E_BOOTSTRAP_DIGEST" >&2
  exit 1
fi
sudo "$bootstrap_path" install \
  --installation-id "$installation_id" \
  --environment-id "$environment_id" \
  --account-id "$account_id" \
  --hetzner-project-id "$hetzner_project_id" \
  --admission "$repository_root/ops/crabbox-coordinator/admission.json" \
  --permission-manifest "$repository_root/ops/crabbox-coordinator/permission-manifest.json" \
  --live-profile "$live_profile" \
  --terminal-profile "$terminal_profile" \
  --terminal-entry-point "$terminal_entry_point" \
  --runtime-closure "$build_root/runtime-closure.tar.gz" \
  --runtime-closure-sha256 "$runtime_closure_sha256" \
  --toolchain-identity "$toolchain_identity"
sudo rm -f -- "$bootstrap_path"
bootstrap_installed=0
