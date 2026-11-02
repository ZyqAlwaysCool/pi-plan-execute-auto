import type { AcpAgent } from "@automatalabs/workflows";
import { isValidReasoningEffort, orderReasoningEfforts, type ReasoningEffort } from "./types.js";

export type AdvertisedConfigOption = AcpAgent["configOptions"][number];

/**
 * Reasoning levels a backend actually advertises for the selected model.
 *
 * Detection must stay category-driven: the four supported ACP servers use different option ids for
 * the same concept — codex `reasoning_effort`, claude `effort`, opencode `effort`, pi
 * `thinkingLevel` — and all of them use `category: "thought_level"`. Matching only an id allowlist
 * (or only the historical low/medium/high/max values) silently truncates the catalog.
 */
export function collectAdvertisedEfforts(options: readonly AdvertisedConfigOption[]): ReasoningEffort[] {
  const efforts: string[] = [];
  for (const option of options) {
    if (option.type !== "select") continue;
    if (!(option.category === "thought_level" || option.id === "reasoning_effort" || option.id === "variant")) continue;
    for (const choice of option.options) {
      const leaves = "value" in choice ? [choice] : choice.options;
      for (const leaf of leaves) {
        if (isValidReasoningEffort(leaf.value)) efforts.push(leaf.value);
      }
    }
  }
  return orderReasoningEfforts(efforts);
}
