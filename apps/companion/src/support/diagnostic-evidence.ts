import { diagnosticValue } from './diagnostic-value.js';
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
/** Collection scope is separate from credential redaction. Keep the producer's field semantics. */
function excludeChat(value: unknown): unknown {
  const record = object(value);
  if (
    ['program_all_chat', 'program_all_chat_reset'].includes(String(record.kind ?? record.stage))
  ) {
    return {
      ...Object.fromEntries(
        Object.entries(record)
          .filter(([name]) =>
            [
              'schema',
              'eventId',
              'producerKind',
              'producerRunId',
              'sequence',
              'kind',
              'stage',
              'phase',
              'outcome',
              'time',
              'observedAt',
              'recordedAt',
              'startupSessionId',
              'taskId',
              'operationId',
              'parentOperationId',
              'attemptId',
              'sourceInterval',
            ].includes(name),
          )
          .map(([name, item]) => [name, excludeChat(item)]),
      ),
      evidence: { excluded: 'raw-chat-body', scope: 'identity and source interval only' },
      coverage: { excluded: ['raw-chat-body'], unknown: [] },
    };
  }
  if (typeof value === 'string') {
    if (/^\s*[{[]/.test(value)) {
      try {
        return JSON.stringify(excludeChat(JSON.parse(value)));
      } catch {
        /* Plain text remains evidence. */
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(excludeChat);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(record).map(([name, item]) => [name, excludeChat(item)]),
    );
  return value;
}
export const diagnosticEvidence = (value: unknown) => diagnosticValue(excludeChat(value));
