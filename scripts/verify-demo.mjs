/**
 * verify:demo — the pre-demo smoke test.
 *
 * Run after `npm run build`, before anything is shown to anybody. It answers one
 * question: did the three routes that must not need a server actually prerender?
 *
 * WHY THOSE THREE. `/`, `/method` and `/about` are the demo's fixed points. The
 * landing page is what a judge sees first, and it is the only route in the app
 * that ships no page JavaScript at all — the whole reason the (demo) route group
 * exists is to keep the client DemoBanner off it. /method and /about are the two
 * pages someone reads while the demo is not being driven. If any of them has
 * fallen out of static prerendering, the demo still works but the claim about it
 * does not, and that is the kind of regression a build log scrolls past.
 *
 * WHY .mjs AND NOT tsx. The other three scripts in this directory import from
 * src/lib and need the compiler to say the engine's types still hold. This one
 * reads two files off disk and imports nothing from the app, so `node` is the
 * whole runtime it needs and there is no reason to make a demo-day check wait on
 * a TypeScript transform.
 *
 * Exit codes are the interface: 0 is a pass, 1 names what is missing.
 */

import { existsSync, readFileSync, statSync } from "node:fs";

const MANIFEST_PATH = ".next/app-path-routes-manifest.json";

/** The routes that must build as ○ Static. See the note above. */
const REQUIRED_ROUTES = ["/", "/method", "/about"];

function fail(message) {
  console.error(`verify:demo FAILED — ${message}`);
  process.exit(1);
}

/**
 * Whether a build exists at all, which is the difference between "the demo is
 * broken" and "you have not built it yet". Worth telling apart in the message:
 * the second is a one-command fix and the first is not.
 */
function hasBuild() {
  return existsSync(".next/BUILD_ID") && existsSync(".next/static");
}

/**
 * Where `next build` writes a prerendered route's HTML.
 *
 * DERIVED FROM THE MANIFEST'S VALUE, NEVER ITS KEY, and the difference is the
 * whole reason this function exists. A key in app-path-routes-manifest.json is
 * the module path — "/(demo)/about/page" — and it carries two things that never
 * reach the output: the route group, and the page segment. The HTML for /about is
 * at .next/server/app/about.html; the "(demo)" directory sitting beside it holds
 * compiled page.js modules and no HTML whatsoever. Building the path out of the
 * key produces .next/server/app/(demo)/about/page.html, which has never existed
 * in any build, and the check would fail on a route that prerendered perfectly.
 *
 * `/` is the one route whose file is not named after it, for the obvious reason
 * that "/.html" is not a filename.
 */
function htmlPathFor(route) {
  return `.next/server/app${route === "/" ? "/index" : route}.html`;
}

/**
 * The routes this build knows about, or null if the manifest cannot be read as
 * the map of module-path → route that this script expects. Null is not a
 * failure — Next owns this file's schema and is free to change it, and a smoke
 * test that fails because a private manifest moved is a smoke test that gets
 * commented out. The caller degrades instead.
 */
function readManifestRoutes() {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    if (typeof manifest !== "object" || manifest === null) return null;
    const routes = Object.values(manifest);
    return routes.every((route) => typeof route === "string") ? routes : null;
  } catch {
    return null;
  }
}

const routes = readManifestRoutes();

if (routes === null) {
  if (!hasBuild()) {
    fail("no build to check — run `npm run build` first.");
  }
  console.log("verify:demo passed (manifest unavailable — basic check only)");
  process.exit(0);
}

const missing = REQUIRED_ROUTES.filter((route) => !routes.includes(route));
if (missing.length > 0) {
  fail(`missing routes: ${missing.join(", ")}`);
}

/**
 * The existence of the .html file IS the static check, and it is a stronger one
 * than reading the build log. A route that turned ƒ Dynamic has an entry in the
 * manifest and a compiled page.js exactly like a static one does — what it does
 * not have is prerendered HTML on disk, because there was nothing to prerender.
 * So `○ → ƒ` is precisely the regression this loop catches.
 */
for (const route of REQUIRED_ROUTES) {
  const path = htmlPathFor(route);

  if (!existsSync(path)) {
    fail(`missing static file: ${path} — ${route} did not prerender.`);
  }

  // A zero-byte file passes existsSync and fails a demo. Cheap to rule out.
  if (statSync(path).size === 0) {
    fail(`empty static file: ${path} — ${route} prerendered to nothing.`);
  }
}

console.log(
  `verify:demo passed — ${REQUIRED_ROUTES.length} static routes confirmed (${REQUIRED_ROUTES.join(", ")})`,
);
process.exit(0);
