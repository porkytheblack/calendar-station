// Effect-typed re-export. The Google Calendar provider plugin is a pure
// data shape (config in, ProviderFactory out), so the /effect skin is just
// the same surface plus type re-exports for consistency with the core's
// `/effect` subpath. Users compose `googleCalendarProvider(...)` into the
// Effect-based station layer.
export * from "./index.js"
