import { useEffect, useState } from 'react';
import type { SurchargesAvatars } from '../../../src/shared/avatars.js';
import type { AidClient } from './client.js';
import { useAidClientFacultatif } from './useAidState.js';

const vide: SurchargesAvatars = {};
const lectures = new WeakMap<AidClient, Promise<SurchargesAvatars>>();

/** Une seule lecture par client, partagée entre les écrans, sans stockage local. */
export function useAvatars(): SurchargesAvatars | null {
  const client = useAidClientFacultatif();
  const [resultat, setResultat] = useState({ client, avatars: vide });
  useEffect(() => {
    if (!client || client.estAppareil) return;
    let active = true;
    let lecture = lectures.get(client);
    if (!lecture) {
      lecture = client.request<{ avatars: SurchargesAvatars }>('GET', '/api/avatars').then(
        (r) => r.avatars ?? vide,
        () => vide,
      );
      lectures.set(client, lecture);
    }
    void lecture.then((avatars) => {
      if (active) setResultat({ client, avatars });
    });
    return () => {
      active = false;
    };
  }, [client]);
  if (client?.estAppareil) return null;
  return resultat.client === client ? resultat.avatars : vide;
}
