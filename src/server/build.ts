declare const __BUILD_TIME__: string | undefined;

/** When this server was built (set by `npm run build`), or "dev". Shown in the status popover and /api/health. */
export const BUILD: string = typeof __BUILD_TIME__ !== "undefined" ? __BUILD_TIME__ : "dev";
