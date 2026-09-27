/**
 * Applies the persisted theme before first paint so the UI never flashes
 * the wrong colour scheme. Must stay dependency-free and synchronous.
 */
const script = `(function(){try{
var t = localStorage.getItem("nexa.theme");
if (t !== "light" && t !== "dark") {
  t = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
document.documentElement.setAttribute("data-theme", t);
}catch(e){document.documentElement.setAttribute("data-theme","dark");}})();`;

export function ThemeBootstrap() {
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}