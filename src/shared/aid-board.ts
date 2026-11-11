/** D290 : seule une ligne exacte établit le lien ; CRLF est accepté. */
export function liensAid(body: string): { projet: string; slug: string }[] {
  return body.split('\n').flatMap((ligne) => {
    const lien =
      /^AID: ([A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100})#([a-z0-9][a-z0-9-]{0,99})$/.exec(
        ligne.endsWith('\r') ? ligne.slice(0, -1) : ligne,
      );
    return lien ? [{ projet: lien[1]!, slug: lien[2]! }] : [];
  });
}
