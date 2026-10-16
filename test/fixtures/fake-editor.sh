#!/usr/bin/env bash
# Faux éditeur : écrit ses arguments, un par ligne, dans $FAKE_EDITOR_OUT.
printf "%s\n" "$@" > "$FAKE_EDITOR_OUT"
