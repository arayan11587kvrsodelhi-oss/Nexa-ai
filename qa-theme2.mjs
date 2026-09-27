export default async function run(page, ui) {
  const probe = async (theme) => {
    await page.evaluate((t) => {
      document.documentElement.setAttribute("data-theme", t);
      try { localStorage.setItem("nexa.theme", t); } catch { }
    }, theme);
    await page.waitForTimeout(250);

    return await page.evaluate(() => {
      const aside = document.querySelector("aside[aria-label='Sidebar']");
      const header = document.querySelector("header");
      const main = document.querySelector("#nexa-main");
      const card = document.querySelector("#nexa-main .rounded-panel");
      const cs = (el) => (el ? getComputedStyle(el) : null);
      return {
        theme: document.documentElement.getAttribute("data-theme"),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        bodyColor: getComputedStyle(document.body).color,
        asideBg: cs(aside)?.backgroundColor,
        headerBg: cs(header)?.backgroundColor,
        mainBg: main ? getComputedStyle(main).backgroundColor : null,
        cardBorder: cs(card)?.borderTopColor,
        cardBg: cs(card)?.backgroundColor,
      };
    });
  };

  const light = await probe("light");
  const dark = await probe("dark");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));

  return { light, dark };
}