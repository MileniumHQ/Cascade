#!/bin/sh
# zypak lets Chromium's sandbox work inside Flatpak's.
export TMPDIR="$XDG_RUNTIME_DIR/app/$FLATPAK_ID"
exec zypak-wrapper /app/cascade/cascade "$@"
