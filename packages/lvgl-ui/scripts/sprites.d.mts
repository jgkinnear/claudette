/** Types for sprites.mjs, which the web UI and tests import to draw the same Claudettes. */
export type SpriteName = string;
export const palette: Record<string, string>;
export const sprites: Record<SpriteName, string[]>;
export const RECOLOUR_KEYS: string[];
export const bodies: { name: string; colours: [string, string, string, string] }[];
export const accents: { name: string; colours: [string, string] }[];
export const clashes: Record<string, string[]>;
export const headwear: SpriteName[];
export const extras: (SpriteName | null)[];
export interface Look {
  body: number;
  hw: number;
  accent: number;
  extra: number;
}
export const classicLook: Look;
export function fnv1a(text: string): number;
export function lookFor(id: string): Look;
