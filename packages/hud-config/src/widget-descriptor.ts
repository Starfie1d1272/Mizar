import { HUD_CANVAS_WIDTH, HUD_CANVAS_HEIGHT } from './constants.js';
import { canonicalJson } from './canonical-json.js';
import { hudWidgetSettingsSchema } from './schemas.js';
import type {
  HudWidgetDescriptor,
  HudWidgetDescriptorDefinition,
  HudWidgetSettings,
} from './types.js';
/**
 * Framework-neutral registry seam. Future widget Issues can register a real
 * renderer and controlled variants without changing the common settings
 * envelope or parser dispatch in this package.
 */
export function defineHudWidgetDescriptor(
  definition: HudWidgetDescriptorDefinition,
): HudWidgetDescriptor {
  const supportedVariants = new Set(definition.supportedVariants);
  if (supportedVariants.size !== definition.supportedVariants.length) {
    throw new Error(`组件 ${definition.id} 的 supportedVariants 不得重复`);
  }
  if (!definition.supportedVariants.includes(definition.defaultVariant)) {
    throw new Error(`组件 ${definition.id} 的 defaultVariant 必须属于 supportedVariants`);
  }
  const parserVariants = Object.keys(definition.settingsSchemaByVariant);
  if (
    parserVariants.length !== supportedVariants.size ||
    parserVariants.some((variant) => !supportedVariants.has(variant))
  ) {
    throw new Error(`组件 ${definition.id} 必须为每个 supported variant 提供独立 settings schema`);
  }
  const defaultVariants = Object.keys(definition.defaultSettingsByVariant);
  if (
    defaultVariants.length !== supportedVariants.size ||
    defaultVariants.some((variant) => !supportedVariants.has(variant))
  ) {
    throw new Error(`组件 ${definition.id} 的 defaults 与 variants 不一致`);
  }
  const labelVariants = Object.keys(definition.variantLabels);
  if (
    labelVariants.length !== supportedVariants.size ||
    labelVariants.some((variant) => !supportedVariants.has(variant))
  ) {
    throw new Error(`组件 ${definition.id} 的 variant labels 与 variants 不一致`);
  }
  const dimensionVariants = Object.keys(definition.dimensionsByVariant);
  if (
    dimensionVariants.length !== supportedVariants.size ||
    dimensionVariants.some((variant) => !supportedVariants.has(variant))
  )
    throw new Error('组件尺寸与 variants 不一致');
  for (const dimensions of Object.values(definition.dimensionsByVariant)) {
    if (
      ![dimensions.width, dimensions.height].every(
        (value) => Number.isFinite(value) && value > 0,
      ) ||
      dimensions.width > HUD_CANVAS_WIDTH ||
      dimensions.height > HUD_CANVAS_HEIGHT
    )
      throw new Error('组件尺寸超出支持范围');
  }
  for (const variant of definition.supportedVariants) {
    if (!definition.variantLabels[variant]?.trim()) throw new Error('Variant 缺少名称');
    const parser = definition.settingsSchemaByVariant[variant]!;
    const defaults = definition.defaultSettingsByVariant[variant]!;
    if (canonicalJson(parser(defaults)) !== canonicalJson(defaults))
      throw new Error('组件 defaults 必须完整');
    const paths = new Set<string>();
    for (const control of definition.editorControls) {
      if (
        control.variants.length === 0 ||
        control.variants.some((item) => !supportedVariants.has(item))
      )
        throw new Error('Control variant 无效');
      if (!control.variants.includes(variant)) continue;
      if (paths.has(control.path)) throw new Error('Control path 重复');
      paths.add(control.path);
      const defaultValue = defaults[control.path];
      if (
        control.type === 'boolean'
          ? typeof defaultValue !== 'boolean'
          : typeof defaultValue !== 'string'
      )
        throw new Error('Control 与 setting 类型不一致');
      const values: readonly (string | boolean)[] =
        control.type === 'boolean' ? [false, true] : control.options.map((option) => option.value);
      if (
        values.length === 0 ||
        new Set(values).size !== values.length ||
        !values.includes(defaultValue as string | boolean)
      )
        throw new Error('Control 缺少合法默认值');
      for (const value of values) parser({ ...defaults, [control.path]: value });
    }
  }
  return {
    ...definition,
    validateSettings: (value: unknown): HudWidgetSettings => {
      const parsed = hudWidgetSettingsSchema.parse(value);
      if (!definition.supportedVariants.includes(parsed.variant)) {
        throw new Error(`组件 ${definition.id} 不支持 variant：${parsed.variant}`);
      }
      const settingsSchema = definition.settingsSchemaByVariant[parsed.variant];
      if (settingsSchema === undefined) {
        throw new Error(`组件 ${definition.id} 缺少 variant settings schema：${parsed.variant}`);
      }
      return {
        variant: parsed.variant,
        settings: settingsSchema(parsed.settings),
      };
    },
  };
}
