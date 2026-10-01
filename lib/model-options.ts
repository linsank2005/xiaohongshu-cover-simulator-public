export const MODEL_OPTIONS = [
  { id: "ollama", label: "Qwen3.5 4B（本机 Ollama · 默认）" },
  { id: "zhipu", label: "GLM-5.3-Flash（智谱）" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "glm-4.6v", label: "GLM-4.6V（智谱）" }
] as const;

export type ModelProvider = (typeof MODEL_OPTIONS)[number]["id"];

export function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === "string" && MODEL_OPTIONS.some((option) => option.id === value);
}
