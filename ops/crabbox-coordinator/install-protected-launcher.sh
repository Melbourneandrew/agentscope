#!/bin/sh
set -eu

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

build_root=$(mktemp -d "${TMPDIR:-/tmp}/agentscope-crabbox-launcher.XXXXXX")
mkdir -m 0700 "$build_root/home"
bootstrap_path="/Library/Application Support/Agentscope/.agentscope-crabbox-control.bootstrap"
bootstrap_installed=0
cleanup() {
  rm -rf -- "$build_root"
  if [ "$bootstrap_installed" -eq 1 ]; then sudo rm -f -- "$bootstrap_path"; fi
}
trap cleanup EXIT HUP INT TERM

# Authenticate the compiler distribution before executing any compiler bytes.
expected_go_archive_sha256=efb87ff28af9a188d0536ef5d42e63dd52ba8263cd7344a993cc48dd11dedb6a
actual_go_archive_sha256=$(shasum -a 256 "$admitted_go_archive" | awk '{print $1}')
if [ "$actual_go_archive_sha256" != "$expected_go_archive_sha256" ]; then
  echo "protected launcher: E_GO_ARCHIVE_DIGEST" >&2
  exit 1
fi
mkdir -m 0700 "$build_root/go-extract"
tar -xzf "$admitted_go_archive" -C "$build_root/go-extract"
go_root=$build_root/go-extract/go
go_binary=$go_root/bin/go
if [ ! -x "$go_binary" ] || [ "$($go_binary version)" != "go version go1.26.5 darwin/arm64" ]; then
  echo "protected launcher: E_GO_TOOLCHAIN" >&2
  exit 1
fi

if [ "$(shasum -a 256 "$repository_root/ops/crabbox-coordinator/admission.json" | awk '{print $1}')" != "947f1c128ca030d89c3e6100ce96a159fc4b045afb36b1cf1ef02276e16e2357" ] ||
   [ "$(shasum -a 256 "$repository_root/ops/crabbox-coordinator/permission-manifest.json" | awk '{print $1}')" != "b8d01f9fe098abc9a67eeba6ee5f8bd18e0b273bbf5bb7766a72e9acc9d2922f" ]; then
  echo "protected launcher: E_CANONICAL_POLICY_DIGEST" >&2
  exit 1
fi

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
if [ "$expected_node_archive_sha256" != "8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d" ] || [ "$actual_node_archive_sha256" != "$expected_node_archive_sha256" ]; then
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
sudo "$bootstrap_path" install \
  --installation-id "$installation_id" \
  --environment-id "$environment_id" \
  --account-id "$account_id" \
  --hetzner-project-id "$hetzner_project_id" \
  --executor-uid "$service_uid" \
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
