<script lang="ts">
  // Minimal touch-sized button (≥44px). shadcn-svelte is not in mobile, so this
  // is a small hand-rolled primitive with the variants the app needs.
  import type { Snippet } from "svelte";
  import { cn } from "$lib/utils";

  type Variant = "default" | "outline" | "secondary" | "ghost" | "destructive";

  interface Props {
    variant?: Variant;
    type?: "button" | "submit";
    disabled?: boolean;
    onclick?: () => void;
    class?: string;
    children: Snippet;
  }

  let { variant = "default", type = "button", disabled = false, onclick, class: klass = "", children }: Props = $props();

  const variants: Record<Variant, string> = {
    default: "bg-brand text-brand-foreground active:bg-brand/90",
    outline: "border border-border bg-transparent active:bg-muted",
    secondary: "bg-secondary text-secondary-foreground active:bg-secondary/80",
    ghost: "bg-transparent active:bg-muted",
    destructive: "bg-destructive text-white active:bg-destructive/90",
  };
</script>

<button
  {type}
  {disabled}
  {onclick}
  class={cn(
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
    variants[variant],
    klass,
  )}
>
  {@render children()}
</button>
