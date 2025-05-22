import express from "express";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json());

async function extractHLTBTimeData(page) {
  await page.waitForSelector("main");

  const result = await page.evaluate(() => {
    const blocks = document.querySelectorAll(".GameStats_game_times__KHrRY > ul > li");
    const timeData = {};
    blocks.forEach(block => {
      const label = block.querySelector("h4")?.textContent?.trim();
      const polled = block.querySelector("h5")?.textContent?.replace(/[^\d]/g, "") || null;
      const times = [];
      block.querySelectorAll("div > div").forEach(div => {
        const txt = div.textContent.trim();
        if (/Average/i.test(txt)) {
          const val = txt.match(/([\d.]+)\s*Hours?/i);
          if (val) timeData[`${label.toLowerCase()}_avg`] = parseFloat(val[1]);
        } else if (/Median/i.test(txt)) {
          const val = txt.match(/([\d.]+)\s*Hours?/i);
          if (val) timeData[`${label.toLowerCase()}_median`] = parseFloat(val[1]);
        } else if (/Rushed/i.test(txt)) {
          const val = txt.match(/([\d.]+)\s*Hours?/i);
          if (val) timeData[`${label.toLowerCase()}_rushed`] = parseFloat(val[1]);
        } else if (/Leisure/i.test(txt)) {
          const val = txt.match(/([\d.]+)\s*Hours?/i);
          if (val) timeData[`${label.toLowerCase()}_leisure`] = parseFloat(val[1]);
        }
      });
      if (polled) timeData[`${label.toLowerCase()}_polled`] = parseInt(polled, 10);
    });
    return timeData;
  });
  return result;
}

async function findHLTBGameUrl(browser, gameName) {
  const searchUrl = `https://howlongtobeat.com/?q=${encodeURIComponent(gameName)}`;
  const page = await browser.newPage();
  await page.goto(searchUrl, { waitUntil: "domcontentloaded" });

  await page.waitForSelector('.GameCard_search_list__IuMbi h2 a[href^="/game/"]');
  const gameLink = await page.evaluate((gameName) => {
    const links = Array.from(document.querySelectorAll('.GameCard_search_list__IuMbi h2 a[href^="/game/"]'));
    for (const a of links) {
        if (a.textContent.trim().toLowerCase() === gameName.toLowerCase()) {
          return a.getAttribute('href');
        }
    }
    return links[0]?.getAttribute('href') || null;
  }, gameName);


  await page.close();
  if (!gamelink) return null;
  // Compose full URL
  return `https://howlongtobeat.com${gamelink}`;
}

app.post("/hltb", async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Missing 'name' in body" });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const url = await findHLTBGameUrl(browser, name);
    if (!url) {
      await browser.close();
      return res.status(404).json({ error: "HLTB page not found" });
    }

    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const times = await extractHLTBTimeData(page);
    await page.close();
    await browser.close();

    return res.json({
      hltb_url: url,
      times
    });
  } catch (err) {
    if (browser) await browser.close();
    return res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => {
  res.send("HLTB Puppeteer microservice running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`HLTB Scraper running on port ${PORT}`);
});
