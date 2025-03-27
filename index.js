const express = require("express");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/get-a00-al-price", async (req, res) => {
  try {
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();
    await page.goto("https://www.ccmn.cn/", { waitUntil: "domcontentloaded" });

    const data = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("table tr"));
      for (let row of rows) {
        const tds = row.querySelectorAll("td");
        if (tds.length && tds[0].innerText.includes("A00铝")) {
          return {
            name: tds[0].innerText.trim(),
            priceRange: tds[1].innerText.trim(),
            avgPrice: Number(tds[2].innerText.trim()),
            change: Number(tds[3].innerText.trim()),
            unit: tds[4].innerText.trim(),
            date: tds[5].innerText.trim()
          };
        }
      }
      return null;
    });

    await browser.close();

    res.json({
      result: data,
      message: data ? "✅ 成功抓取 A00铝数据" : "❌ 未找到 A00铝数据"
    });
  } catch (error) {
    console.error("❌ 错误日志:", error);
    res.json({
      result: null,
      message: `❌ 抓取失败：${error.message}`
    });
  }
});

app.get("/", (req, res) => {
  res.send("✅ 铝价中转服务已部署成功");
});

app.listen(PORT, () => {
  console.log(`✅ 服务启动：http://localhost:${PORT}`);
});
