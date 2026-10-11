/* Where the landing page's buttons go. Build-time values (not secrets): the Pages build points "Open app" at the always-on Mac. */

export const REPO_URL: string = import.meta.env.VITE_REPO_URL || "https://github.com/Yash-1706/goa-hacks";
/** the GitHub Pages copy sets VITE_SITE_APP_URL (pnpm run site:build); the copy the Mac serves opens its own /app */
export const SITE_APP_URL: string = import.meta.env.VITE_SITE_APP_URL || "/app";
