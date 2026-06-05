// Re-export shim. The canonical display-only DTOs now live in the shared
// `@zca/types` package so the mobile app can reuse them. Desktop code keeps
// importing `$lib/types` unchanged; new/shared code should import from
// "@zca/types" directly.
export * from "@zca/types";
