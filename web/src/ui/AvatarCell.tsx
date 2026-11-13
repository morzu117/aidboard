import { avatarCell, PALETTE_AVATARS } from '../../../src/shared/avatars.js';
import { useAvatars } from '../data/avatars.js';

export function AvatarCell({ nom, cellLocale }: { nom: string; cellLocale?: string }) {
  const surcharges = useAvatars();
  if (surcharges === null) return null;
  const avatar = avatarCell(nom, surcharges);
  const couleur = PALETTE_AVATARS.find((c) => c.id === avatar.couleur) ?? PALETTE_AVATARS[7];
  const locale = !!nom && nom === cellLocale;
  return (
    <span
      aria-hidden="true"
      className={`avatar-cell${locale ? ' avatar-cell--locale' : ''}`}
      title={locale ? 'cette cell' : undefined}
      data-initiales={avatar.initiales}
      style={{ backgroundColor: couleur.valeur, color: couleur.ink }}
    />
  );
}
