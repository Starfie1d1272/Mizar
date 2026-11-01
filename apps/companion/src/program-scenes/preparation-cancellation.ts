// Shared by the lifecycle and OBS request handlers; cancellation is scoped to
// one preparation identity and does not revoke unrelated operator requests.
const cancelled = new Set<string>();
export const cancelPreparation = (id: string) => cancelled.add(id);
export const preparationCancelled = (id: string) => cancelled.has(id);
