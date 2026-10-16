#!/usr/bin/env bash
# Contrat des scripts d'action : code 0 succès, 2 action humaine requise, autre erreur.
# Une ligne « ::aid:: {json} » sur stdout est lue comme résultat structuré.

die_human() {
  echo "$1" >&2
  exit 2
}

die() {
  echo "$1" >&2
  exit 1
}

require_env() {
  local name
  for name in "$@"; do
    [ -n "${!name:-}" ] || die "variable manquante : $name"
  done
}
