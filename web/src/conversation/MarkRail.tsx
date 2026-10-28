const LONGUEUR_MAX_INFOBULLE = 120;

const tronquer = (s: string): string =>
  s.length > LONGUEUR_MAX_INFOBULLE ? `${s.slice(0, LONGUEUR_MAX_INFOBULLE)}…` : s;

export interface QuestionRepere {
  seq: number;
  text: string;
  at: string;
  marked: boolean;
}

// Rail de repères (§5.3.2) : un trait par question, cliquable, qui défile jusqu'à elle.
export function MarkRail({
  questions,
  active,
  onSelect,
  dataNode,
}: {
  questions: QuestionRepere[];
  active: number | null;
  onSelect: (seq: number) => void;
  dataNode: string;
}) {
  if (questions.length === 0) return null;
  return (
    <div className="repere-rail" data-node={dataNode}>
      {questions.map((q) => {
        const isActive = q.seq === active;
        const classe = [
          'repere-trait',
          isActive && 'repere-trait--actif',
          q.marked && 'repere-trait--marque',
        ]
          .filter(Boolean)
          .join(' ');
        const infobulle = tronquer(q.text);
        return (
          <button
            key={q.seq}
            type="button"
            className={classe}
            data-node={`${dataNode}.q-${q.seq}`}
            title={infobulle}
            aria-label={infobulle}
            onClick={() => onSelect(q.seq)}
          />
        );
      })}
    </div>
  );
}
