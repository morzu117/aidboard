import json
import os
import sys

from swarph_cli import local_proxy
from swarph_cli.commands.proxy import run_proxy

with open(sys.argv[1], encoding="utf-8") as fichier:
    cellule_uid = json.load(fichier)["cell_uid"]
uid_pair = local_proxy.peer_uid
# Tests seulement : un seul utilisateur joue le proxy et la cellule distincte.
local_proxy.peer_uid = lambda connexion: (
    cellule_uid if uid_pair(connexion) == os.getuid() else uid_pair(connexion)
)
sys.exit(run_proxy(["serve", "--cell", "peer-a", "--config", sys.argv[1]]))
