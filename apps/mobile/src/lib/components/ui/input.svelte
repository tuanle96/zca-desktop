<script lang="ts">
  // Minimal touch-sized text input. Uses controlled value + oninput (rather than
  // bind:value) so `type` can stay dynamic (email/url/text) without Svelte's
  // two-way-binding-with-dynamic-type restriction.
  import { cn } from "$lib/utils";

  interface Props {
    value?: string;
    type?: "text" | "email" | "url" | "search";
    placeholder?: string;
    disabled?: boolean;
    id?: string;
    autocapitalize?: "off" | "none" | "sentences" | "words" | "characters";
    autocorrect?: "on" | "off";
    inputmode?: "text" | "email" | "url" | "numeric";
    class?: string;
  }

  let {
    value = $bindable(""),
    type = "text",
    placeholder = "",
    disabled = false,
    id,
    autocapitalize = "off",
    autocorrect = "off",
    inputmode,
    class: klass = "",
  }: Props = $props();
</script>

<input
  {id}
  {type}
  {placeholder}
  {disabled}
  {autocapitalize}
  {autocorrect}
  {inputmode}
  {value}
  oninput={(e) => (value = e.currentTarget.value)}
  class={cn(
    "border-input text-foreground min-h-11 w-full rounded-lg border bg-transparent px-3 text-base outline-none transition-colors focus:border-ring disabled:opacity-50",
    klass,
  )}
/>
