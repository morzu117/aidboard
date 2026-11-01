# Chantier 18 (DL1) : le serveur du labo — vrai sshd, vrai tmux, trois shells de connexion. Node sert
# aux faux agents, que `claude` et `codex` enveloppent (DL5). Aucune clé dans l'image : la clé publique
# du run est copiée au démarrage dans /etc/ssh/labo_authorized_keys (DL2, DL4).
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-server tmux zsh git procps ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Comptes sans mot de passe utilisable mais pas verrouillés (`*`) : sshd refuse un compte verrouillé.
RUN useradd -m -s /bin/bash aid \
  && useradd -m -s /bin/zsh aidzsh \
  && useradd -m -s /bin/dash aiddash \
  && for u in aid aidzsh aiddash; do usermod -p '*' "$u"; done \
  && touch /home/aidzsh/.zshrc && chown aidzsh: /home/aidzsh/.zshrc

RUN mkdir -p /run/sshd /opt/aid-fixtures \
  && printf '%s\n' \
    'PasswordAuthentication no' \
    'KbdInteractiveAuthentication no' \
    'PermitRootLogin no' \
    'AllowUsers aid aidzsh aiddash' \
    'AuthorizedKeysFile /etc/ssh/labo_authorized_keys' \
    'UsePAM no' \
    'PrintMotd no' \
    > /etc/ssh/sshd_config.d/labo.conf \
  && printf '#!/bin/sh\nexec node /opt/aid-fixtures/fake-claude-stream.mjs "$@"\n' > /usr/local/bin/claude \
  && printf '#!/bin/sh\nexec node /opt/aid-fixtures/fake-codex-appserver.mjs "$@"\n' > /usr/local/bin/codex \
  && chmod 755 /usr/local/bin/claude /usr/local/bin/codex

# Clés d'hôte générées au premier démarrage, pas à la construction : une par conteneur.
CMD ["sh", "-c", "ssh-keygen -A >/dev/null && exec /usr/sbin/sshd -D -e"]
