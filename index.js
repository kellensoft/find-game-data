import express from "express";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

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
  console.log(found.href);
  return found?.href ? `https://howlongtobeat.com${found.href}` : null;
}

async function extractHLTBTimeData(page) {
  try {
    await page.waitForSelector(".GameTimeTable_game_main_table__7uN3H tbody", { timeout: 10000 });
  } catch (e) {
    console.error("Timeout waiting for HLTB time data:", e);
    return {};
  }

  const result = await page.evaluate(() => {
    
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

    const res = {
      main_avg: null, main_polled: null, main_median: null, main_rushed: null, main_leisure: null,
      extra_avg: null, extra_polled: null, extra_median: null, extra_rushed: null, extra_leisure: null,
      completionist_avg: null, completionist_polled: null, completionist_median: null, completionist_rushed: null, completionist_leisure: null,
    };

    const rows = Array.from(document.querySelectorAll(".GameTimeTable_game_main_table__7uN3H tbody tr"));
    rows.forEach(row => {
      const cells = Array.from(row.querySelectorAll('td'));
      if (cells.length < 6) return;
      const label = cells[0].textContent.trim().toLowerCase();

      if (label.startsWith("main story")) {
        res.main_polled    = parseInt(cells[1].textContent.replace(/[^\d]/g, "")) || null;
        res.main_avg       = parseTimeToMinutes(cells[2].textContent.trim());
        res.main_median    = parseTimeToMinutes(cells[3].textContent.trim());
        res.main_rushed    = parseTimeToMinutes(cells[4].textContent.trim());
        res.main_leisure   = parseTimeToMinutes(cells[5].textContent.trim());
      } else if (label.startsWith("main + extras")) {
        res.extra_polled   = parseInt(cells[1].textContent.replace(/[^\d]/g, "")) || null;
        res.extra_avg      = parseTimeToMinutes(cells[2].textContent.trim());
        res.extra_median   = parseTimeToMinutes(cells[3].textContent.trim());
        res.extra_rushed   = parseTimeToMinutes(cells[4].textContent.trim());
        res.extra_leisure  = parseTimeToMinutes(cells[5].textContent.trim());
      } else if (label.startsWith("completionist")) {
        res.completionist_polled   = parseInt(cells[1].textContent.replace(/[^\d]/g, "")) || null;
        res.completionist_avg      = parseTimeToMinutes(cells[2].textContent.trim());
        res.completionist_median   = parseTimeToMinutes(cells[3].textContent.trim());
        res.completionist_rushed   = parseTimeToMinutes(cells[4].textContent.trim());
        res.completionist_leisure  = parseTimeToMinutes(cells[5].textContent.trim());
      }
    });

    return res;
  });

  return result;
}

function normalizeHLTBTimeData(hltbUrl, times) {
  const m = hltbUrl.match(/\/game\/(\d+)/);
  const hltb_id = m ? parseInt(m[1], 10) : null;

  const map = {
    "main story_polled": "main_polled",
    "main story_avg": "main_avg",
    "main story_median": "main_median",
    "main story_rushed": "main_rushed",
    "main story_leisure": "main_leisure",
    "main + sides_polled": "extra_polled",
    "main + sides_avg": "extra_avg",
    "main + sides_median": "extra_median",
    "main + sides_rushed": "extra_rushed",
    "main + sides_leisure": "extra_leisure",
    "completionist_polled": "completionist_polled",
    "completionist_avg": "completionist_avg",
    "completionist_median": "completionist_median",
    "completionist_rushed": "completionist_rushed",
    "completionist_leisure": "completionist_leisure"
  };

  const result = {
    hltb_id,
    main_avg: null,
    main_polled: null,
    main_median: null,
    main_rushed: null,
    main_leisure: null,
    extra_avg: null,
    extra_polled: null,
    extra_median: null,
    extra_rushed: null,
    extra_leisure: null,
    completionist_avg: null,
    completionist_polled: null,
    completionist_median: null,
    completionist_rushed: null,
    completionist_leisure: null,
  };

  for (const [k, v] of Object.entries(times)) {
    const mapped = map[k];
    if (mapped && mapped in result) {
      result[mapped] = v ?? null;
    }
  }
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

    await page.setViewport({ width: 1280, height: 1024 });
    await page.emulateTimezone('America/New_York');

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    const html = await page.content();
    console.log(html);

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
