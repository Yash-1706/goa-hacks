/* ngrok's free plan puts a browser warning page in front of the site (once every 7 days, then a cookie). An API call that hits
 * it would get HTML instead of JSON, so every fetch to an ngrok host says "skip it". A WebSocket cannot send custom headers:
 * it relies on that cookie, set when the page itself loaded. */

const NGROK = /\.ngrok(-free)?\.(app|dev|io)$/i;

export function tunnelHeaders(hostname: string = typeof location === "undefined" ? "" : location.hostname): Record<string, string> {
  return NGROK.test(hostname) ? { "ngrok-skip-browser-warning": "1" } : {};
}
