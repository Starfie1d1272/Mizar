import { z } from 'zod';
import definition from './lifecycle-contract.json' with { type: 'json' };

// The JSON definition is also read by the native host. Response extensions are
// tolerated by the host; commands remain strict at the local service boundary.
type StringRule = { min?: number; max?: number; format?: string; values?: readonly string[] };
function stringShape<T extends Record<string, StringRule>>(rules: T) {
  return Object.fromEntries(
    Object.entries(rules).map(([name, rule]) => {
      let value = z.string();
      if (rule.min !== undefined) value = value.min(rule.min);
      if (rule.max !== undefined) value = value.max(rule.max);
      if (rule.format !== undefined) {
        if (rule.format !== 'uuid') throw new Error('Unsupported lifecycle format');
        value = value.regex(new RegExp(definition.patterns.uuid));
      }
      if (rule.values) value = value.refine((candidate) => rule.values!.includes(candidate));
      return [name, value];
    }),
  ) as { [K in keyof T]: z.ZodString };
}
export const qualificationSchema = z.strictObject(stringShape(definition.qualification));
export const productionViewSchema = z.object(stringShape(definition.productionView)).passthrough();
export const cancellationResponseSchema = z
  .object(
    Object.fromEntries(
      Object.keys(definition.cancellationResponse).map((name) => [name, z.boolean()]),
    ),
  )
  .passthrough();
export const lifecycleErrors = definition.errors;
