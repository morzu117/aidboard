// Chantier 30 (D165, révision du lab, DM 91283) : l'en-tête que seul le fetch du cockpit pose.
// Une navigation ou un formulaire ne peut pas poser d'en-tête : une requête par cookie qui n'a ni
// Sec-Fetch-Site ni cet en-tête ne vient pas du cockpit.
export const EN_TETE_COCKPIT = 'x-aid-cockpit';
