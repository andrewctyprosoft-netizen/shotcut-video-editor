#!/usr/bin/env bash
# ShotCut launcher for Linux and macOS (macOS users double-click ShotCut.command, which runs this).
# The first run downloads everything ShotCut needs into the "runtime" folder here (about 1.5 GB, internet needed once):
# a portable Node.js, the Electron runtime, FFmpeg, Python with faster-whisper, and the Whisper speech model.
# Nothing is installed system-wide. The setup itself is setup/launch.mjs.
set -eu
cd "$(dirname "$0")"
NODE_VERSION=24.22.1

fail() {
  echo
  echo "ShotCut could not start: $1"
  # Keep a terminal window opened by a double-click on screen.
  if [ -t 0 ]; then read -r -p "Press Enter to close." _ || true; fi
  exit 1
}

if [ ! -x runtime/node/bin/node ]; then
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "this launcher supports macOS and Linux (use ShotCut.bat on Windows)." ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "unsupported processor $(uname -m)." ;;
  esac
  # A Terminal running under Rosetta reports x86_64 on Apple silicon.
  if [ "$os" = darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi

  name="node-v$NODE_VERSION-$os-$arch"
  base="https://nodejs.org/dist/v$NODE_VERSION"
  echo "First run: setting ShotCut up. This downloads about 1.5 GB and takes a few minutes."
  echo "Downloading Node.js $NODE_VERSION ($os $arch)..."
  mkdir -p runtime
  get() {
    if command -v curl >/dev/null 2>&1; then curl -fL --retry 3 --progress-bar -o "$2" "$1"
    elif command -v wget >/dev/null 2>&1; then wget -q --show-progress -O "$2" "$1"
    else fail "neither curl nor wget is installed; install one of them first."
    fi
  }
  get "$base/$name.tar.gz" "runtime/$name.tar.gz" || fail "the Node.js download failed. Check the internet connection."
  get "$base/SHASUMS256.txt" runtime/SHASUMS256.txt || fail "the Node.js checksum download failed."
  expected="$(grep "  $name.tar.gz\$" runtime/SHASUMS256.txt | cut -d' ' -f1 || true)"
  if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "runtime/$name.tar.gz" | cut -d' ' -f1)"
  else actual="$(shasum -a 256 "runtime/$name.tar.gz" | cut -d' ' -f1)"
  fi
  rm -f runtime/SHASUMS256.txt
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    rm -f "runtime/$name.tar.gz"
    fail "the Node.js download is damaged (checksum mismatch). Run the launcher again."
  fi
  tar -xzf "runtime/$name.tar.gz" -C runtime || fail "could not unpack Node.js."
  rm -rf runtime/node "runtime/$name.tar.gz"
  mv "runtime/$name" runtime/node
fi

runtime/node/bin/node setup/launch.mjs "$@" || fail "see the messages above."
