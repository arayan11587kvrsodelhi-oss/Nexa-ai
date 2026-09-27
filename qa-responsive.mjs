export default async function run(page) {
  const shots = [];

  // Desktop: sidebar visible, mobile-only elements hidden.
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => {
    localStorage.setItem("nexa.theme", "dark");
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "shot-desktop-dark.png", fullPage: false });

  const desktop = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute("data-theme"),
    sidebarVisible: document.querySelector("aside").getBoundingClientRect().width,
    mobileMarkVisible:
      document.querySelector("header .md\\:hidden svg")?.getBoundingClientRect()
        .width ?? 0,
    // Is the drawer closed on desktop?
    drawerOpen: Boolean(document.querySelector("[aria-label='Navigation']")),
  }));
  shots.push({ viewport: "desktop", desktop });

  // Mobile: sidebar collapses, drawer button appears, no stray marks.
  await page.setViewportSize({ width: 390, height: 780 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: "shot-mobile-dark.png", fullPage: false });

  const mobile = await page.evaluate(() => {
    const burger = Array.from(document.querySelectorAll("button")).find((b) =>
      /open navigation/i.test(b.getAttribute("aria-label") || "")
    );
    const sidebar = document.querySelector("aside");
    const mark = document.querySelector("header .md\\:hidden svg");
    return {
      sidebarRendered: sidebar ? sidebar.getBoundingClientRect().width : 0,
      sidebarHiddenByCss: sidebar
        ? getComputedStyle(sidebar).display
        : "absent",
      burgerVisible: burger ? burger.getBoundingClientRect().width > 0 : false,
      headerMark: mark
        ? {
          w: Math.round(mark.getBoundingClientRect().width),
          x: Math.round(mark.getBoundingClientRect().x),
        }
        : null,
      paletteButtonPresent: Boolean(
        Array.from(document.querySelectorAll("button")).find((b) =>
          b.innerText.includes("Command palette")
        )
      ),
    };
  });
  shots.push({ viewport: "mobile", mobile });

  // Now open the drawer and confirm the sidebar arrives with the wordmark.
  const snap = await page.locator("button[aria-label='Open navigation']");
  if (await snap.count()) {
    await snap.click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: "shot-mobile-drawer.png", fullPage: false });
    shots.push({
      drawer: await page.evaluate(() => {
        const d = document.querySelector("[aria-label='Navigation']");
        return {
          open: Boolean(d),
          width: d ? Math.round(d.getBoundingClientRect().width) : 0,
          hasWordmark: d ? /NEXA/.test(d.innerText) : false,
          bodyScrollLocked: getComputedStyle(document.body).overflow,
        };
      }),
    });
  }

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  return shots;
}