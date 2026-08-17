export interface ThemeTokens { id: string; name: string; type: 'light' | 'dark'; colors: Record<string, string>; }
const REQUIRED = ['bg.base', 'bg.surface', 'text.primary', 'text.secondary', 'accent.base', 'border'];
export function validateTheme(t: any): t is ThemeTokens {
  for (const k of REQUIRED) if (typeof t?.colors?.[k] !== 'string') throw new Error(`theme missing colors.${k}`);
  return true;
}
export function tokensToCssVars(t: ThemeTokens): string {
  const vars = Object.entries(t.colors).map(([k, v]) => `--tt-${k}: ${v};`);
  return `:root { ${vars.join(' ')} }`;
}
