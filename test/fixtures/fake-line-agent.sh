#!/bin/sh
# Faux agent ligne à ligne (chantier 17, R.2) : une ligne JSON par réponse, pour vérifier le relais.
# « lent N » écrit N lignes espacées de 0,2 s (de la sortie pendant une coupure), « quit » sort en 0,
# « fail » en 3 ; toute autre ligne est renvoyée en écho.
while IFS= read -r ligne; do
  case "$ligne" in
    quit) exit 0 ;;
    fail) exit 3 ;;
    lent\ *)
      n=${ligne#lent }
      i=1
      while [ "$i" -le "$n" ]; do
        printf '{"n":%s}\n' "$i"
        i=$((i + 1))
        sleep 0.2
      done
      ;;
    *) printf '{"echo":"%s"}\n' "$ligne" ;;
  esac
done
