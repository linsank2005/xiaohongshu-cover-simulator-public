import { GRID_CARD_NAMES, VERTICAL_CARD_NAMES, type TestMode } from "./types";

export const AGENTS_PER_VARIANT = 100;
export function cardNamesForMode(mode: TestMode): readonly string[] {
  return mode === "vertical" ? VERTICAL_CARD_NAMES : GRID_CARD_NAMES;
}

export function isValidChoice(choice: unknown, mode: TestMode): choice is string {
  return typeof choice === "string" && (choice === "NONE" || cardNamesForMode(mode).includes(choice));
}

export function determineWinner(variants: ReadonlyArray<{ key: string; selectedCount: number; totalTrials: number }>): "A" | "B" | "tie" | null {
  if (variants.length !== 2 || variants.some(item => item.totalTrials !== AGENTS_PER_VARIANT)) return null;
  const a = variants.find(item => item.key === "A");
  const b = variants.find(item => item.key === "B");
  if (!a || !b) return null;
  const difference = a.selectedCount * b.totalTrials - b.selectedCount * a.totalTrials;
  return difference === 0 ? "tie" : difference > 0 ? "A" : "B";
}
