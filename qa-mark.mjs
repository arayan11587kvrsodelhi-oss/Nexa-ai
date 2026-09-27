export default async function run(page) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  return await page.evaluate(() => {
    // Report the ACTUAL markup and geometry of the first sidebar mark so I stop
    // reasoning from a low-res thumbnail.
    const aside = document.querySelector("aside");
    const firstSvg = aside.querySelector("svg");
    const r = firstSvg?.getBoundingClientRect();
    const paths = firstSvg
      ? Array.from(firstSvg.querySelectorAll("path")).map((p) => ({
        d: p.getAttribute("d"),
        stroke: p.getAttribute("stroke") || getComputedStyle(p).stroke,
        strokeWidth: p.getAttribute("stroke-width"),
      }))
      : null;

    return {
      svgOuterHTML: firstSvg?.outerHTML.slice(0, 700) ?? null,
      rect: r
        ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        : null,
      fill: firstSvg ? getComputedStyle(firstSvg).fill : null,
      svgColor: firstSvg ? getComputedStyle(firstSvg).color : null,
      paths,
      // What colour actually lands on the pentagon stroke?
      firstPathStroke: firstSvg
        ? getComputedStyle(firstSvg.querySelector("path")).stroke
        : null,
    };
  });
}