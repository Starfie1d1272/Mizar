import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';

/** Resolve built-in presentation assets; projected team and player URLs stay unchanged. */
export type AssetUrlResolver = (path: string) => string;
const identity: AssetUrlResolver = (path) => path;
const AssetContext = createContext<AssetUrlResolver>(identity);

export function AssetProvider({
  resolve = identity,
  children,
}: {
  readonly resolve?: AssetUrlResolver | undefined;
  readonly children?: ReactNode;
}) {
  return <AssetContext.Provider value={resolve}>{children}</AssetContext.Provider>;
}
export function useAssetUrl(): AssetUrlResolver {
  return useContext(AssetContext);
}
export function assetCssUrl(url: string): string {
  return `url(${JSON.stringify(url).replaceAll('<', '\\3c ')})`;
}
export function assetStyle(resolve: AssetUrlResolver): CSSProperties {
  return {
    '--mizar-asset-ewc-contour': assetCssUrl(resolve('/brand/hud/ewc/contour.svg')),
    '--mizar-asset-esl-texture': assetCssUrl(resolve('/brand/hud/esl/texture.svg')),
  } as CSSProperties;
}
export function AssetFonts() {
  const resolve = useAssetUrl();
  const font = (family: string, path: string, weight: string, format: string) =>
    `@font-face{font-family:${family};src:${assetCssUrl(resolve(path))} format(${JSON.stringify(format)});font-weight:${weight};font-display:swap}`;
  return (
    <style>
      {[
        font(
          '"Barlow Condensed"',
          '/brand/fonts/barlow-condensed/BarlowCondensed-Bold.ttf',
          '700',
          'truetype',
        ),
        font('ESLLegend', '/brand/fonts/esl/legend-regular.woff2', '400', 'woff2'),
        font('ESLLegend', '/brand/fonts/esl/legend-bold.woff2', '600 900', 'woff2'),
        font('ESLLegend', '/brand/fonts/esl/legend-light.woff2', '300', 'woff2'),
        font('SourceHanSans', '/brand/fonts/esl/SourceHanSansCN-Regular.woff2', '400', 'woff2'),
      ].join('\n')}
    </style>
  );
}
