/*
 * Applies the persisted theme before first paint so the UI never flashes the
 * wrong colour scheme.
 *
 * Served as a static file and loaded with a plain, render-blocking <script src>
 * in the document head, deliberately rather than as an inline element.
 *
 * WHY NOT AN INLINE `<script nonce={...}>` RENDERED BY REACT
 *
 * Browsers implement CSP *nonce hiding*: once a nonced <script> has been
 * parsed, the `nonce` content attribute is emptied while the internal nonce
 * (the IDL HTMLScriptElement.nonce property) is retained. This is deliberate
 * — it stops scripts from reading the nonce back out of the DOM.
 *
 * React 19 has no special case for `nonce`. During hydration it diffs every
 * prop against the DOM using getAttribute(prop), which returns "" for a hidden
 * nonce. A React-owned <script nonce={nonce}> therefore can never match:
 *
 *     Prop `nonce` did not match. Server: "" Client: "<32 hex chars>"
 *
 * Note which side is which: `Server` is what React read from the DOM
 * (warnForPropDifference is passed getAttribute's result), and `Client` is
 * React's own prop. The served HTML is correct; React's read of it is not.
 *
 * No change to where the nonce is *read from* can fix this, because the
 * divergence happens in the browser after the HTML is parsed. Measured in
 * Chromium: the served HTML carries the real nonce, and after parsing
 * getAttribute('nonce') === "" while el.nonce still holds all 32 characters.
 *
 * Next.js's own scripts never trip this, because they are written straight
 * into the HTML stream instead of being rendered as React elements, so React
 * never diffs them. Measured on this page: 24 nonced scripts, of which exactly
 * one carried a __reactProps$ key — the one rendered by this component.
 *
 * WHY AN EXTERNAL FILE IS THE RIGHT ANSWER, NOT A WORKAROUND
 *
 * `script-src` already contains 'self', so this file is permitted precisely
 * because it is same-origin — no nonce attribute is needed on it, and none is
 * added, so there is nothing for React to disagree about. This removes an
 * inline script from the page rather than hiding a mismatch, which is
 * strictly *stronger* than the inline version: there is one fewer inline
 * script an attacker would need a nonce injection to reach. The nonce-based
 * policy is untouched and still guards every script the framework emits.
 *
 * A plain <script src> in the head is render-blocking, so it executes before
 * the first paint of the body and cannot cause a flash of the wrong theme. An
 * async or dynamically injected script would not be safe here.
 */
(function () {
  try {
    var t = localStorage.getItem("nexa.theme");
    if (t !== "light" && t !== "dark") {
      t = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    document.documentElement.setAttribute("data-theme", t);
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
