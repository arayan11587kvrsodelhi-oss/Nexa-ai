export default async function run(page, ui) {
  // Force a clean dark theme and a reload at desktop width so the header's
  // mobile-only wordmark is genuinely out of the layout.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    localStorage.setItem("nexa.theme", "dark");
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  return await page.evaluate(() => {
    const aside = document.querySelector("aside[aria-label='Sidebar']");
    const paletteBtn = Array.from(document.querySelectorAll("button")).find((b) =>
      b.innerText.includes("Command palette")
    );
    // Which SVGs are visible right now?
    const svgs = Array.from(document.querySelectorAll("aside svg")).map((s) => {
      const r = s.getBoundingClientRect();
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        x: Math.round(r.x),
        y: Math.round(r.y),
        paths: s.querySelectorAll("path").length,
        parent: s.parentElement?.tagName,
      };
    });

    // Is there any element overlapping the palette button?
    const pr = paletteBtn?.getBoundingClientRect();
    const overlapping = pr
      ? Array.from(document.querySelectorAll("aside *"))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return (
            r.width > 0 &&
            r.height > 0 &&
            el !== paletteBtn &&
            !paletteBtn.contains(el) &&
            !el.contains(paletteBtn) &&
            r.left < pr.right &&
            r.right > pr.left &&
            r.top < pr.bottom &&
            r.bottom > pr.top
          );
        })
        .map((el) => `${el.tagName}.${el.className?.toString().slice(0, 40)}`)
      : null;

    return {
      theme: document.documentElement.getAttribute("data-theme"),
      themeAttributeOnHtml: document.documentElement.outerHTML.slice(0, 120),
      asideBg: getComputedStyle(aside).backgroundColor,
      headerBg: getComputedStyle(document.querySelector("header")).backgroundColor,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      mobileWordmarkVisible: (() => {
        const el = document.querySelector("header .md\\:hidden");
        if (!el) return "not-found";
        const cs = getComputedStyle(el);
        return { display: cs.display, visible: el.getBoundingClientRect().width > 0 };
      })(),
      svgCount: svgs.length,
      svgs: svgs.slice(0, 6),
      overlapping,
    };
  });
}