/* Where the landing page's buttons go. Build-time values, not secrets. */

export const REPO_URL: string = import.meta.env.VITE_REPO_URL || "https://github.com/Yash-1706/goa-hacks";
/** the copy the Mac serves opens its own /app; the public GitHub Pages copy has no app to open (VITE_SITE_APP_URL is empty) */
export const SITE_APP_URL: string = import.meta.env.VITE_SITE_APP_URL || "";
/** the full demo videos: a page on the GitHub Pages site (the Pages build links it relatively) */
export const DEMO_URL: string = import.meta.env.VITE_DEMO_URL || "https://sayedzahur786.github.io/synapse-site/demo/";
