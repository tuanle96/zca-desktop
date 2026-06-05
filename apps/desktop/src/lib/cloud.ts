// Re-export shim. The canonical cloud client now lives in the shared
// `@zca/core-client` package so the mobile app can reuse it. Desktop code keeps
// importing `$lib/cloud` unchanged; new/shared code should import from
// "@zca/core-client" directly.
export * from "@zca/core-client";
