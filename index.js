import express from "express";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import cheerio from "cheerio";

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json());

async function findHLTBGameUrl(browser, gameName) {
  const searchUrl = `https://howlongtobeat.com/?q=${encodeURIComponent(gameName)}`;
  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
  });

  await page.goto(searchUrl, { waitUntil: "domcontentloaded" });

  let foundLinks = [];
  try {
    foundLinks = await page.$$eval('.GameCard_search_list__IuMbi h2 a[href^="/game/"]', links =>
      links.map(a => ({ text: a.textContent.trim(), href: a.getAttribute('href') }))
    );
    if (!foundLinks.length) {
      foundLinks = await page.$$eval('h2 a[href^="/game/"]', links =>
        links.map(a => ({ text: a.textContent.trim(), href: a.getAttribute('href') }))
      );
    }
  } catch (e) {
    console.error("Selector error or empty results.");
  }

  await page.close();

  if (!foundLinks.length) return null;

  const found = foundLinks.find(
    a => a.text.toLowerCase() === gameName.toLowerCase()
  ) || foundLinks[0];
  return found?.href ? `https://howlongtobeat.com${found.href}` : null;
}

function parseTimeToMinutes(txt) {
  if (!txt) return null;
  txt = txt.replace(/\s+/g, " ").replace("½", ".5").toLowerCase();
  let total = 0;
  const h = txt.match(/(\d+(\.\d+)?)\s*h/);
  const m = txt.match(/(\d+)\s*m/);
  if (h) total += parseFloat(h[1]) * 60;
  if (m) total += parseInt(m[1], 10);
  if (!h && !m) {
    const hourFloat = txt.match(/([\d.]+)\s*hours?/i);
    if (hourFloat) total = parseFloat(hourFloat[1]) * 60;
  }
  return total > 0 ? Math.round(total) : null;
}

async function extractHLTBTimeData(page) {
  // Wait for at least something to load
  await page.waitForSelector("table.GameTimeTable_game_main_table__7uN3H", { timeout: 10000 }).catch(() => {});
  const html = await page.content();
  const $ = cheerio.load(html);

  const res = {
    main_avg: null, main_polled: null, main_median: null, main_rushed: null, main_leisure: null,
    extra_avg: null, extra_polled: null, extra_median: null, extra_rushed: null, extra_leisure: null,
    completionist_avg: null, completionist_polled: null, completionist_median: null, completionist_rushed: null, completionist_leisure: null,
  };

  $("table.GameTimeTable_game_main_table__7uN3H tbody tr").each((i, row) => {
    const cells = $(row).find("td").toArray().map(td => $(td).text().trim());
    if (cells.length < 6) return;
    const label = cells[0].toLowerCase();

    if (label.startsWith("main story")) {
      res.main_polled    = parseInt(cells[1].replace(/[^\d]/g, "")) || null;
      res.main_avg       = parseTimeToMinutes(cells[2]);
      res.main_median    = parseTimeToMinutes(cells[3]);
      res.main_rushed    = parseTimeToMinutes(cells[4]);
      res.main_leisure   = parseTimeToMinutes(cells[5]);
    } else if (label.startsWith("main + extras") || label.startsWith("main + sides")) {
      res.extra_polled   = parseInt(cells[1].replace(/[^\d]/g, "")) || null;
      res.extra_avg      = parseTimeToMinutes(cells[2]);
      res.extra_median   = parseTimeToMinutes(cells[3]);
      res.extra_rushed   = parseTimeToMinutes(cells[4]);
      res.extra_leisure  = parseTimeToMinutes(cells[5]);
    } else if (label.startsWith("completionist")) {
      res.completionist_polled   = parseInt(cells[1].replace(/[^\d]/g, "")) || null;
      res.completionist_avg      = parseTimeToMinutes(cells[2]);
      res.completionist_median   = parseTimeToMinutes(cells[3]);
      res.completionist_rushed   = parseTimeToMinutes(cells[4]);
      res.completionist_leisure  = parseTimeToMinutes(cells[5]);
    }
  });

  return res;
}

function normalizeHLTBTimeData(hltbUrl, times) {
  const m = hltbUrl.match(/\/game\/(\d+)/);
  const hltb_id = m ? parseInt(m[1], 10) : null;

  const result = {
    hltb_id,
    main_avg: times.main_avg ?? null,
    main_polled: times.main_polled ?? null,
    main_median: times.main_median ?? null,
    main_rushed: times.main_rushed ?? null,
    main_leisure: times.main_leisure ?? null,
    extra_avg: times.extra_avg ?? null,
    extra_polled: times.extra_polled ?? null,
    extra_median: times.extra_median ?? null,
    extra_rushed: times.extra_rushed ?? null,
    extra_leisure: times.extra_leisure ?? null,
    completionist_avg: times.completionist_avg ?? null,
    completionist_polled: times.completionist_polled ?? null,
    completionist_median: times.completionist_median ?? null,
    completionist_rushed: times.completionist_rushed ?? null,
    completionist_leisure: times.completionist_leisure ?? null,
  };

  return result;
}

app.post("/hltb", async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Missing 'name' in body" });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      timeout: 60000,
    });

    const url = await findHLTBGameUrl(browser, name);
    if (!url) {
      await browser.close();
      return res.status(404).json({ error: "HLTB page not found" });
    }

    const page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });

    const times = await extractHLTBTimeData(page);
    await page.close();
    await browser.close();

    return res.json(normalizeHLTBTimeData(url, times));
  } catch (err) {
    if (browser) await browser.close();
    console.error("Scraper error:", err);
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
