import { z } from 'zod';

const sideSchema = z.enum(['CT', 'T']);

const entrant = z.object({ name: z.string(), logoUrl: z.string().nullable() }).strict();
export const bpProjectionSchema = z
  .object({
    competition: z.string(),
    stage: z.string(),
    format: z.enum(['bo1', 'bo3', 'bo5']),
    entrants: z.object({ a: entrant, b: entrant }).strict(),
    cards: z
      .array(
        z
          .object({
            mapName: z.string(),
            kind: z.enum(['ban', 'pick', 'decider']),
            entrant: z.enum(['a', 'b']).nullable(),
            sideChoice: z
              .object({ entrant: z.enum(['a', 'b']), side: sideSchema })
              .strict()
              .nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(7),
    steps: z
      .array(
        z
          .object({
            cardIndex: z.number().int().min(0).max(6),
            kind: z.enum(['card', 'side-choice']),
          })
          .strict(),
      )
      .min(1)
      .max(14),
  })
  .strict()
  .refine((p) => {
    const expectedKinds = {
      bo1: ['ban', 'ban', 'ban', 'ban', 'ban', 'ban', 'decider'],
      bo3: ['ban', 'ban', 'pick', 'pick', 'ban', 'ban', 'decider'],
      bo5: ['ban', 'ban', 'pick', 'pick', 'pick', 'pick', 'decider'],
    }[p.format];
    if (
      new Set(p.cards.map((c) => c.mapName)).size !== p.cards.length ||
      p.cards.length !== expectedKinds.length ||
      p.cards.some((card, index) => card.kind !== expectedKinds[index])
    )
      return false;
    if (
      p.cards.some(
        (c) =>
          (c.kind === 'decider' ? c.entrant !== null : c.entrant === null) ||
          (c.sideChoice !== null && c.kind === 'ban'),
      )
    )
      return false;
    if (p.format === 'bo5' && p.cards.at(-1)?.sideChoice !== null) return false;
    const cards = new Set<number>();
    const sides = new Set<number>();
    for (const [stepIndex, step] of p.steps.entries()) {
      const card = p.cards[step.cardIndex];
      if (!card) return false;
      if (step.kind === 'card') {
        if (cards.has(step.cardIndex)) return false;
        cards.add(step.cardIndex);
      } else {
        const previous = p.steps[stepIndex - 1];
        if (
          !cards.has(step.cardIndex) ||
          sides.has(step.cardIndex) ||
          card.sideChoice === null ||
          previous?.kind !== 'card' ||
          previous.cardIndex !== step.cardIndex
        )
          return false;
        sides.add(step.cardIndex);
      }
    }
    return (
      cards.size === p.cards.length &&
      p.cards.every((card, index) => (card.sideChoice !== null) === sides.has(index))
    );
  });
export const bpSnapshotSchema = z
  .object({
    schemaVersion: z.literal('mizar.bp.v2'),
    revision: z.string().min(1),
    projection: bpProjectionSchema.nullable(),
    state: z.enum(['hidden', 'revealing', 'shown', 'hiding']),
    revealedCount: z.number().int().min(0).max(14),
  })
  .strict()
  .refine(
    (s) =>
      s.revealedCount <= (s.projection?.steps.length ?? 0) &&
      (s.projection !== null || s.state === 'hidden') &&
      (s.state !== 'hidden' || s.revealedCount === 0) &&
      (s.state === 'hidden' || s.revealedCount > 0) &&
      (s.state !== 'shown' || s.revealedCount === s.projection?.steps.length),
  );
export type BpSnapshot = z.infer<typeof bpSnapshotSchema>;
export type BpProjection = z.infer<typeof bpProjectionSchema>;

export const bpDemoFormatSchema = z.enum(['bo1', 'bo3', 'bo5']);
export type BpDemoFormat = z.infer<typeof bpDemoFormatSchema>;
export const bpDemoStateSchema = z.object({ active: bpDemoFormatSchema.nullable() }).strict();
export type BpDemoState = z.infer<typeof bpDemoStateSchema>;
export const bpDemoCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start'), format: bpDemoFormatSchema }).strict(),
  z.object({ kind: z.literal('exit') }).strict(),
]);
export type BpDemoCommand = z.infer<typeof bpDemoCommandSchema>;
export const bpDemoCommandResultSchema = z
  .object({
    ok: z.literal(true),
    demo: bpDemoStateSchema,
    bpRevision: z.string().min(1).max(128),
  })
  .strict();

const localEntrantSchema = z
  .object({
    name: z.string().max(80),
    logoUrl: z.string().max(512).nullable(),
  })
  .strict();

export const localBpDraftSchema = z
  .object({
    competitionName: z.string().max(120),
    stage: z.string().max(120),
    format: z.enum(['bo1', 'bo3', 'bo5']),
    entrants: z.object({ a: localEntrantSchema, b: localEntrantSchema }).strict(),
    vetoA: z.enum(['a', 'b']),
    mapPool: z.array(z.string().max(40)).max(10),
    bans: z.array(z.string().max(40)).max(6),
    picks: z
      .array(z.object({ mapName: z.string().max(40), side: sideSchema.nullable() }).strict())
      .max(4),
    deciderSide: sideSchema.nullable(),
  })
  .strict();
export type LocalBpDraft = z.infer<typeof localBpDraftSchema>;

const bpWorkspaceMatchSchema = z
  .object({
    competition: z.string(),
    stage: z.string(),
    format: z.enum(['bo1', 'bo3', 'bo5']),
    entrants: z.object({ a: localEntrantSchema, b: localEntrantSchema }).strict(),
  })
  .strict();

const bpWorkspaceCandidateSchema = z
  .object({
    revision: z.string().min(1),
    competition: z.string(),
    stage: z.string(),
    format: z.enum(['bo1', 'bo3', 'bo5']),
    entrants: z
      .object({
        a: z.object({ name: z.string().max(80) }).strict(),
        b: z.object({ name: z.string().max(80) }).strict(),
      })
      .strict(),
  })
  .strict();

export const bpWorkspaceSchema = z
  .object({
    schemaVersion: z.literal('mizar.bp-workspace.v4'),
    demo: bpDemoStateSchema,
    source: z.enum(['none', 'online', 'local', 'cache', 'fixture']),
    authoringMode: z.enum(['standalone', 'bound-overlay']),
    contextRevision: z.string().min(1),
    freshness: z.enum(['none', 'fresh', 'stale']),
    readiness: z.enum(['unbound', 'ready', 'missing', 'incomplete', 'conflict']),
    match: bpWorkspaceMatchSchema.nullable(),
    authoringDraft: localBpDraftSchema.nullable(),
    localDraft: localBpDraftSchema.nullable(),
    pendingRivalhub: bpWorkspaceCandidateSchema.nullable(),
    mapPoolOptions: z.array(z.object({ mapName: z.string(), label: z.string() }).strict()).min(7),
    defaultMapPool: z.array(z.string()).length(7),
  })
  .strict();
export type BpWorkspace = z.infer<typeof bpWorkspaceSchema>;
