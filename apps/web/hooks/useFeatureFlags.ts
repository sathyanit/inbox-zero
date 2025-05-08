import {
  useFeatureFlagEnabled,
  useFeatureFlagVariantKey,
} from "posthog-js/react";

export function useCleanerEnabled() {
  return useFeatureFlagEnabled("inbox-cleaner");
}

const HERO_FLAG_NAME = "hero-copy-7";

export type HeroVariant = "control" | "clean-up-in-minutes";

export function useHeroVariant() {
  return (useFeatureFlagVariantKey(HERO_FLAG_NAME) as HeroVariant) || "control";
}

export function useHeroVariantEnabled() {
  return useFeatureFlagEnabled(HERO_FLAG_NAME);
}

export type PricingVariant = "control" | "basic-business" | "business-basic";

export function usePricingVariant() {
  return (
    (useFeatureFlagVariantKey("pricing-options-2") as PricingVariant) ||
    "control"
  );
}

export type SkipUpgradeVariant = "control" | "skip-button";

export function useSkipUpgrade() {
  return (
    (useFeatureFlagVariantKey("skip-upgrade") as SkipUpgradeVariant) ||
    "control"
  );
}

export type PricingFrequencyDefault = "control" | "monthly";

export function usePricingFrequencyDefault() {
  return (
    (useFeatureFlagVariantKey(
      "pricing-frequency-default",
    ) as PricingFrequencyDefault) || "control"
  );
}
