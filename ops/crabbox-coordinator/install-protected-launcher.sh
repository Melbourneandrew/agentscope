#!/bin/sh
set -eu

# Builds and installs only the nonsecret protected control plane. It does not
# log in, read a cloud/provider credential, call a network service, or run
# Wrangler.
if [ "$#" -ne 10 ]; then
  echo "usage: $0 INSTALLATION_ID ENVIRONMENT_ID ACCOUNT_ID HETZNER_PROJECT_ID CRABBOX_SOURCE ADMITTED_NPM TOOLCHAIN_IDENTITY LIVE_PROFILE TERMINAL_PROFILE TERMINAL_ENTRY_POINT" >&2
  exit 64
fi

installation_id=$1
environment_id=$2
account_id=$3
hetzner_project_id=$4
crabbox_source=$5
admitted_npm=$6
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
cleanup() { rm -rf -- "$build_root"; }
trap cleanup EXIT HUP INT TERM

(
  cd "$repository_root/tools/crabbox-launcher"
  env -i HOME="$build_root/home" PATH="$go_root/bin:/usr/bin:/bin" GOTOOLCHAIN=local CGO_ENABLED=0 \
    "$go_binary" test ./...
  env -i HOME="$build_root/home" PATH="$go_root/bin:/usr/bin:/bin" GOTOOLCHAIN=local CGO_ENABLED=0 \
    "$go_binary" build -trimpath -buildvcs=true -o "$build_root/agentscope-crabbox-control" ./cmd/agentscope-crabbox-control
)

sudo install -d -o root -g wheel -m 0755 "/Library/Application Support/Agentscope"
sudo "$build_root/agentscope-crabbox-control" install \
  --installation-id "$installation_id" \
  --environment-id "$environment_id" \
  --account-id "$account_id" \
  --hetzner-project-id "$hetzner_project_id" \
  --admission "$repository_root/ops/crabbox-coordinator/admission.json" \
  --permission-manifest "$repository_root/ops/crabbox-coordinator/permission-manifest.json" \
  --live-profile "$live_profile" \
  --terminal-profile "$terminal_profile" \
  --terminal-entry-point "$terminal_entry_point" \
  --npm "$admitted_npm" \
  --crabbox-source "$crabbox_source" \
  --toolchain-identity "$toolchain_identity"
