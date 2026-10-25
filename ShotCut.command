#!/usr/bin/env bash
# ShotCut launcher for macOS: double-click in Finder. It runs ShotCut.sh, which sets ShotCut up on the first run.
cd "$(dirname "$0")" && exec bash ./ShotCut.sh "$@"
