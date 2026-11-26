import { Type, type Static } from '@sinclair/typebox';

const Outil = Type.Object(
  {
    version: Type.Optional(Type.String()),
    verifier: Type.Optional(Type.Array(Type.String({ pattern: '^[^\\u0000]*$' }), { minItems: 1 })),
    requis: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const Outils = Type.Record(Type.String({ pattern: '^[a-z0-9][a-z0-9._-]*$' }), Outil, {
  additionalProperties: false,
});

export const ManifesteOutils = Type.Object({ outils: Type.Optional(Outils) });

export type OutilDeclare = Static<typeof Outil>;
