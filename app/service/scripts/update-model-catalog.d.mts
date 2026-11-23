// Types of update-model-catalog.mjs, for the tests that import its pure functions.
export interface CatalogEntry {
  id: string;
  lab: string;
  name: string;
  vision: boolean;
  pdf: boolean;
  reasoning: boolean;
  chat: boolean;
  contextTokens?: number;
  reasoningLevels?: string[];
  tools?: true;
  audioIn?: true;
  videoIn?: true;
  imageOut?: true;
  videoOut?: true;
  audioOut?: true;
}
export interface CatalogProvider {
  id: string;
  hosts: string[];
  models: string[];
}
export const MODELS_URL: string;
export const API_URL: string;
export const LEVELS: string[];
export const ABILITIES: string[];
export const GUARD: { maxShrink: number; maxAbleLost: number };
export function diffCatalog(prev: ReadonlyArray<CatalogEntry>, next: ReadonlyArray<CatalogEntry>): { added: string[]; removed: string[]; changed: string[] };
export function catalogSummary(prev: ReadonlyArray<CatalogEntry>, next: ReadonlyArray<CatalogEntry>): string;
export function guardCatalog(prev: ReadonlyArray<CatalogEntry>, next: ReadonlyArray<CatalogEntry>): void;
export function levelsOf(entry: unknown): string[] | undefined;
export function reduceCatalog(models: unknown, api?: unknown): CatalogEntry[];
export const DNS_NAME: RegExp;
export function reduceProviders(api: unknown): CatalogProvider[];
export function formatCatalog(entries: ReadonlyArray<CatalogEntry | CatalogProvider>): string;
export function catalogReadme(facts: { fetched: string; count: number; providers?: number }): string;
