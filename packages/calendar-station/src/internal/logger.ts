import type { StationLogger } from "./types.js"

const ts = (): string => new Date().toISOString()

export const consoleLogger: StationLogger = {
  debug: (event, fields) =>
    console.debug(JSON.stringify({ level: "debug", ts: ts(), event, ...fields })),
  info: (event, fields) =>
    console.info(JSON.stringify({ level: "info", ts: ts(), event, ...fields })),
  warn: (event, fields) =>
    console.warn(JSON.stringify({ level: "warn", ts: ts(), event, ...fields })),
  error: (event, fields) =>
    console.error(JSON.stringify({ level: "error", ts: ts(), event, ...fields })),
}

export const noopLogger: StationLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
