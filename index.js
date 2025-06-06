const express = require("express");
const puppeteer = require("puppeteer");
const path = require("path");
const cron = require("node-cron");
const axios = require("axios");
const fs = require("fs");
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3003;

// 配置文件路径
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DB_FILE = path.join(__dirname, 'al_price.db');
console.log('数据库文件路径:', DB_FILE);

// 时区设置
process.env.TZ = 'Asia/Shanghai';

// 告警阈值
const ALERT_THRESHOLD = 3;
const RETRY_INTERVAL = 5 * 60 * 1000; // 5分钟重试一次
let fetchFailCount = 0;
let webhookFailCount = 0;
let hasSentToday = false;
let retryIntervalId = null;

// 登录配置（可写入 config.json 或用环境变量管理）
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

app.use(session({
  secret: 'al-price-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 2 * 60 * 60 * 1000 } // 2小时
}));

// 登录校验中间件
function requireLogin(req, res, next) {
  if (req.session && req.session.loggedIn) {
    next();
  } else {
    res.redirect('/login');
  }
}

// 读取配置文件
function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const conf = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      // 兼容老配置
      return {
        webhookUrl: conf.webhookUrl || '',
        webhookToken: conf.webhookToken || '',
        alertWebhookUrl: conf.alertWebhookUrl || '',
        alertWebhookToken: conf.alertWebhookToken || '',
        tasks: conf.tasks || []
      };
    }
  } catch (error) {
    console.error('读取配置文件失败:', error);
  }
  return {
    webhookUrl: '',
    webhookToken: '',
    alertWebhookUrl: '',
    alertWebhookToken: '',
    tasks: []
  };
}

// 保存配置文件
function saveConfig(config) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    console.error('保存配置文件失败:', error);
    return false;
  }
}

// 解析请求体
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static('public'));

// Webhook配置
let config = readConfig();

// 获取当前日期数字（YYYYMMDD）
function getTodayNum() {
  const now = new Date();
  return Number(`${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`);
}

// 格式化日期时间
function formatDateTime(date) {
  return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

// 日志写入函数
function writeLog(msg) {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const logFile = path.join(__dirname, `app-${dateStr}.log`);
  const logMsg = `[${formatDateTime(now)}] ${msg}\n`;
  fs.appendFileSync(logFile, logMsg);
}

// 只判断是否为周末
function isWorkday() {
  const today = new Date();
  const day = today.getDay();
  // 0:周日, 6:周六
  return day !== 0 && day !== 6;
}

// 抓取铝价数据的函数，支持传入品种参数
async function fetchAlPrice(task) {
  const { name, url, selector } = task;
  try {
    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu"
      ]
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const data = await page.evaluate((selector, name) => {
      const rows = Array.from(document.querySelectorAll("table tr"));
      for (let row of rows) {
        const tds = row.querySelectorAll("td");
        if (tds.length && tds[0].innerText.includes(selector)) {
          let rawDate = tds[5].innerText.trim();
          let now = new Date();
          let year = now.getFullYear();
          let dateStr = rawDate.replace(/[^0-9]/g, '');
          if (dateStr.length === 4) {
            dateStr = year + dateStr;
          }
          return {
            name: name || tds[0].innerText.trim(),
            priceRange: tds[1].innerText.trim(),
            avgPrice: Number(tds[2].innerText.trim()),
            change: Number(tds[3].innerText.trim()),
            unit: tds[4].innerText.trim(),
            date: Number(dateStr)
          };
        }
      }
      return null;
    }, selector, name);

    await browser.close();
    console.log(`✅ ${formatDateTime(new Date())} - 抓取执行:`, data);
    writeLog(`✅ 抓取执行: ${JSON.stringify(data)}`);
    
    if (!data) {
      fetchFailCount++;
      writeLog(`[Alert] 抓取返回空数据，失败次数：${fetchFailCount}`);
      if (fetchFailCount >= ALERT_THRESHOLD) {
        const msg = `连续${fetchFailCount}次抓取返回空数据，请检查网站是否可访问`;
        addAlert('抓取失败', msg);
        sendFeishuAlert(msg);
        fetchFailCount = 0;
      }
      return null;
    }

    // 重置失败计数
    fetchFailCount = 0;

    const db = new sqlite3.Database(DB_FILE);
    if (!data.avgPrice || data.avgPrice <= 0) {
      const msg = `抓取到异常数据，均价为${data.avgPrice}，数据：${JSON.stringify(data)}`;
      addAlert('数据异常', msg);
      sendFeishuAlert(msg);
    }

    // 保存到数据库
    db.run(
      `INSERT INTO al_price_history (name, priceRange, avgPrice, change, unit, date) VALUES (?, ?, ?, ?, ?, ?)`,
      [data.name, data.priceRange, data.avgPrice, data.change, data.unit, data.date],
      async (err) => {
        if (err) {
          writeLog(`[DB] 保存数据失败: ${err.message}`);
          return;
        }
        
        // 检查今天是否已经发送过
        if (!hasSentToday) {
          try {
            writeLog(`[Webhook] 准备发送数据: ${JSON.stringify(data)}`);
            await axios.post(
              config.webhookUrl,
              data,
              {
                headers: {
                  'Authorization': `Bearer ${config.webhookToken}`,
                  'Content-Type': 'application/json'
                }
              }
            );
            writeLog(`[Webhook] 数据发送成功: ${JSON.stringify(data)}`);
            hasSentToday = true;
            webhookFailCount = 0;
          } catch (e) {
            webhookFailCount++;
            writeLog(`[Webhook] 发送失败: ${e.message}`);
            if (webhookFailCount >= ALERT_THRESHOLD) {
              const msg = `连续${webhookFailCount}次Webhook推送失败，最近错误：${e.message}`;
              addAlert('推送失败', msg);
              sendFeishuAlert(msg);
              webhookFailCount = 0;
            }
          }
        } else {
          writeLog(`[Webhook] 今日已发送过数据，跳过发送`);
        }
      }
    );

    return data;
  } catch (error) {
    console.error(`❌ ${formatDateTime(new Date())} - 抓取失败:`, error);
    writeLog(`❌ 抓取失败: ${error.message}`);
    fetchFailCount++;
    if (fetchFailCount >= ALERT_THRESHOLD) {
      const msg = `连续${fetchFailCount}次抓取失败，最近错误：${error.message}`;
      addAlert('抓取失败', msg);
      sendFeishuAlert(msg);
      fetchFailCount = 0;
    }
    return null;
  }
}

// 启动重试循环
function startRetryLoop() {
  if (retryIntervalId) return; // 已在重试中，避免重复启动

  retryIntervalId = setInterval(async () => {
    const todayNum = getTodayNum();
    const db = new sqlite3.Database(DB_FILE);
    const hasTodayData = await new Promise(resolve => {
      db.get('SELECT * FROM al_price_history WHERE date = ?', [todayNum], (err, row) => {
        if (err) {
          writeLog(`[DB] 检查当日数据失败: ${err.message}`);
          resolve(false);
        } else {
          resolve(!!row);
        }
      });
    });

    if (hasTodayData) {
      writeLog('[Retry] 数据已存在，继续监控...');
      return;
    }

    writeLog('[Retry] 未检测到当日数据，开始抓取...');
    await smartFetchAll();
  }, RETRY_INTERVAL);
}

// 智能抓取：遍历所有任务，A00铝为主
async function smartFetchAll() {
  const todayNum = getTodayNum();
  
  // 先检查数据库是否有当日数据
  const db = new sqlite3.Database(DB_FILE);
  const hasTodayData = await new Promise((resolve) => {
    db.get('SELECT * FROM al_price_history WHERE date = ?', [todayNum], (err, row) => {
      if (err) {
        writeLog(`[DB] 检查当日数据失败: ${err.message}`);
        resolve(false);
      } else {
        resolve(!!row);
      }
    });
  });

  if (hasTodayData) {
    writeLog(`[System] 今日任务已完成，无需抓取`);
    return [{ data: null, webhookSent: false }];
  }

  let results = [];
  let tasks = (config.tasks && Array.isArray(config.tasks)) ? config.tasks : [];
  // 确保A00铝一定被抓取
  if (!tasks.find(t => t.name === 'A00铝')) {
    tasks.unshift({ name: 'A00铝', url: 'https://www.ccmn.cn/', selector: 'A00铝' });
  }
  for (const task of tasks) {
    const data = await fetchAlPrice(task);
    if (data && data.date === todayNum) {
      let webhookSent = false;
      try {
        writeLog(`[Webhook] 准备发送数据: ${JSON.stringify(data)}`);
        await axios.post(
          config.webhookUrl,
          data,
          {
            headers: {
              'Authorization': `Bearer ${config.webhookToken}`,
              'Content-Type': 'application/json'
            }
          }
        );
        webhookSent = true;
        hasSentToday = true;
        fetchFailCount = 0;
        writeLog(`[Webhook] 数据发送成功: ${JSON.stringify(data)}`);
      } catch (e) {
        webhookFailCount++;
        writeLog(`[Webhook] 发送失败: ${e.message}`);
        if (webhookFailCount >= ALERT_THRESHOLD) {
          const msg = `连续${webhookFailCount}次Webhook推送失败，最近错误：${e.message}`;
          addAlert('推送失败', msg);
          sendFeishuAlert(msg);
          webhookFailCount = 0;
        }
      }
      results.push({ data, webhookSent });
    } else {
      results.push({ data: null, webhookSent: false });
    }
  }

  // 检查是否需要重试
  const hasFailed = results.some(r => !r.data || r.data.date !== todayNum);
  if (hasFailed) {
    writeLog(`[Retry] 抓取失败或获取到前一天数据，开始持续重试`);
    startRetryLoop();
  }

  return results;
}

// 定时任务：每天早上10点执行
cron.schedule("0 10 * * *", async () => {
  console.log(`🕒 ${formatDateTime(new Date())} - 开始执行定时任务`);
  if (await isWorkday()) {
    await smartFetchAll();
  } else {
    console.log("⛔ 今天不是交易日，不执行抓取任务。");
  }
});

// 每天零点重置发送标记和重试计时器
cron.schedule("0 0 * * *", () => {
  hasSentToday = false;
  if (retryIntervalId) {
    clearInterval(retryIntervalId);
    retryIntervalId = null;
  }
  writeLog(`[System] 重置每日发送标记和重试计时器`);
});

// /update-config GET 路由返回配置管理页面
app.get('/update-config', requireLogin, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>铝价服务管理</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 20px auto; padding: 0 20px; }
        .container { background: #f5f5f5; padding: 20px; border-radius: 8px; }
        h1 { color: #333; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; }
        input[type="text"] { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; }
        button { background: #4CAF50; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #45a049; }
        .status { margin-top: 20px; padding: 10px; border-radius: 4px; }
        .success { background: #dff0d8; color: #3c763d; }
        .error { background: #f2dede; color: #a94442; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>铝价服务管理</h1>
        <form id="configForm">
          <div class="form-group">
            <label for="webhookUrl">Webhook URL:</label>
            <input type="text" id="webhookUrl" name="webhookUrl" value="${config.webhookUrl}" required>
          </div>
          <div class="form-group">
            <label for="webhookToken">Webhook Token:</label>
            <input type="text" id="webhookToken" name="webhookToken" value="${config.webhookToken}" required>
          </div>
          <div class="form-group">
            <label for="alertWebhookUrl">告警 Webhook URL:</label>
            <input type="text" id="alertWebhookUrl" name="alertWebhookUrl" value="${config.alertWebhookUrl || ''}" placeholder="可选，建议单独建群">
          </div>
          <div class="form-group">
            <label for="alertWebhookToken">告警 Webhook Token:</label>
            <input type="text" id="alertWebhookToken" name="alertWebhookToken" value="${config.alertWebhookToken || ''}" placeholder="可选">
          </div>
          <button type="submit">保存配置</button>
        </form>
        <div id="status" class="status" style="display: none;"></div>
      </div>
      <script>
        document.getElementById('configForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const status = document.getElementById('status');
          try {
            const response = await fetch('/update-config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                webhookUrl: document.getElementById('webhookUrl').value,
                webhookToken: document.getElementById('webhookToken').value,
                alertWebhookUrl: document.getElementById('alertWebhookUrl').value,
                alertWebhookToken: document.getElementById('alertWebhookToken').value
              })
            });
            const result = await response.json();
            status.textContent = result.message;
            status.className = 'status ' + (result.success ? 'success' : 'error');
            status.style.display = 'block';
          } catch (error) {
            status.textContent = '保存失败: ' + error.message;
            status.className = 'status error';
            status.style.display = 'block';
          }
        });
      </script>
    </body>
    </html>
  `);
});

// /history/api 原API接口
app.get('/history/api', requireLogin, (req, res) => {
  const { date, name, startDate, endDate } = req.query;
  let sql = 'SELECT * FROM al_price_history WHERE 1=1';
  const params = [];
  if (date) {
    sql += ' AND date = ?';
    params.push(Number(date));
  }
  if (startDate) {
    sql += ' AND date >= ?';
    params.push(Number(startDate));
  }
  if (endDate) {
    sql += ' AND date <= ?';
    params.push(Number(endDate));
  }
  if (name) {
    sql += ' AND name = ?';
    params.push(name);
  }
  sql += ' ORDER BY date DESC, id DESC LIMIT 100';
  const db = new sqlite3.Database(DB_FILE);
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ data: rows });
  });
});

// /history GET 返回表格页面
app.get('/history', requireLogin, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <title>历史数据表格</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .filter { margin-bottom: 20px; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ccc; padding: 8px; text-align: center; }
        th { background: #f5f5f5; }
        button { margin-left: 10px; }
      </style>
    </head>
    <body>
      <h1>历史数据表格</h1>
      <div class="filter">
        <label>日期: <input type="date" id="date"></label>
        <label>品名: <input type="text" id="name" placeholder="如A00铝"></label>
        <button id="queryBtn">查询</button>
        <button id="deleteBtn">批量删除</button>
      </div>
      <table id="dataTable">
        <thead>
          <tr>
            <th><input type="checkbox" id="selectAll"></th>
            <th>ID</th><th>品名</th><th>区间</th><th>均价</th><th>涨跌</th><th>单位</th><th>日期</th><th>入库时间</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
      <script>
        function formatDate(num) {
          if (!num) return '';
          const s = num.toString();
          return s.slice(0,4)+'-'+s.slice(4,6)+'-'+s.slice(6,8);
        }
        function loadData() {
          const date = document.getElementById('date').value.replace(/-/g, '');
          const name = document.getElementById('name').value.trim();
          let params = [];
          if (date) params.push('date=' + date);
          if (name) params.push('name=' + encodeURIComponent(name));
          let url = '/history/api' + (params.length ? '?' + params.join('&') : '');
          fetch(url)
            .then(r => r.json())
            .then(function(result) {
              const rows = result.data;
              const tbody = document.querySelector('#dataTable tbody');
              tbody.innerHTML = rows.map(function(row) {
                return '<tr><td><input type="checkbox" class="row-checkbox" data-id="' + row.id + '"></td><td>' + row.id + '</td><td>' + row.name + '</td><td>' + row.priceRange + '</td><td>' + row.avgPrice + '</td><td>' + row.change + '</td><td>' + row.unit + '</td><td>' + formatDate(row.date) + '</td><td>' + row.created_at + '</td></tr>';
              }).join('');
            });
        }
        document.getElementById('queryBtn').onclick = loadData;
        document.getElementById('selectAll').onclick = function() {
          const checkboxes = document.querySelectorAll('.row-checkbox');
          checkboxes.forEach(cb => cb.checked = this.checked);
        };
        document.getElementById('deleteBtn').onclick = function() {
          const selected = Array.from(document.querySelectorAll('.row-checkbox:checked')).map(cb => cb.dataset.id);
          if (selected.length === 0) {
            alert('请选择要删除的记录');
            return;
          }
          if (confirm('确定要删除选中的 ' + selected.length + ' 条记录吗？')) {
            fetch('/history/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids: selected })
            })
            .then(r => r.json())
            .then(function(result) {
              if (result.success) {
                alert('删除成功');
                loadData();
              } else {
                alert('删除失败: ' + result.message);
              }
            });
          }
        };
        loadData();
      </script>
    </body>
    </html>
  `);
});

// 新增 /history/delete 接口，支持批量删除
app.post('/history/delete', requireLogin, (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json({ success: false, message: '未选择记录' });
  }
  const placeholders = ids.map(() => '?').join(',');
  const sql = `DELETE FROM al_price_history WHERE id IN (${placeholders})`;
  const db = new sqlite3.Database(DB_FILE);
  db.run(sql, ids, function(err) {
    if (err) {
      return res.json({ success: false, message: err.message });
    }
    res.json({ success: true, message: `成功删除 ${this.changes} 条记录` });
  });
});

// /get-a00-al-price/api 原API接口
app.get('/get-a00-al-price/api', requireLogin, async (req, res) => {
  try {
    // 支持 name 参数
    const { name } = req.query;
    let task = null;
    if (name) {
      task = (config.tasks || []).find(t => t.name === name);
      if (!task && name === 'A00铝') {
        task = { name: 'A00铝', url: 'https://www.ccmn.cn/', selector: 'A00铝' };
      }
    } else {
      task = (config.tasks || []).find(t => t.name === 'A00铝') || { name: 'A00铝', url: 'https://www.ccmn.cn/', selector: 'A00铝' };
    }
    const data = await fetchAlPrice(task);
    res.json({
      result: data,
      message: data
        ? `✅ 成功抓取 ${task.name} 数据`
        : `❌ 未找到 ${task.name} 数据`
    });
  } catch (error) {
    console.error("❌ 错误日志:", error);
    res.json({
      result: null,
      message: `❌ 抓取失败：${error.message}`
    });
  }
});

// /get-a00-al-price GET 返回美观表格页面
app.get('/get-a00-al-price', requireLogin, async (req, res) => {
  let lastData = null;
  await new Promise(resolve => {
    db.get('SELECT * FROM al_price_history ORDER BY id DESC LIMIT 1', [], (err, row) => {
      lastData = row;
      resolve();
    });
  });
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <title>当前执行结果</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ccc; padding: 8px; text-align: center; }
        th { background: #f5f5f5; }
      </style>
    </head>
    <body>
      <h1>当前执行结果</h1>
      <table>
        <thead>
          <tr>
            <th>ID</th><th>品名</th><th>区间</th><th>均价</th><th>涨跌</th><th>单位</th><th>日期</th><th>入库时间</th>
          </tr>
        </thead>
        <tbody>
          ${lastData ? `<tr><td>${lastData.id}</td><td>${lastData.name}</td><td>${lastData.priceRange}</td><td>${lastData.avgPrice}</td><td>${lastData.change}</td><td>${lastData.unit}</td><td>${lastData.date}</td><td>${lastData.created_at}</td></tr>` : '<tr><td colspan="8">暂无数据</td></tr>'}
        </tbody>
      </table>
    </body>
    </html>
  `);
});

// 登录页面
app.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <title>后台登录</title>
      <style>
        body { font-family: Arial, sans-serif; background: #f5f5f5; }
        .login-box { max-width: 350px; margin: 80px auto; background: #fff; padding: 30px 30px 20px 30px; border-radius: 8px; box-shadow: 0 2px 8px #ccc; }
        h2 { text-align: center; margin-bottom: 20px; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; }
        input[type="text"], input[type="password"] { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; }
        button { width: 100%; background: #4CAF50; color: white; padding: 10px; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #45a049; }
        .error { color: #a94442; margin-bottom: 10px; text-align: center; }
      </style>
    </head>
    <body>
      <div class="login-box">
        <h2>后台登录</h2>
        <form method="POST" action="/login">
          <div class="form-group">
            <label>用户名</label>
            <input type="text" name="username" required>
          </div>
          <div class="form-group">
            <label>密码</label>
            <input type="password" name="password" required>
          </div>
          <button type="submit">登录</button>
        </form>
        ${req.query.error ? '<div class="error">用户名或密码错误</div>' : ''}
      </div>
    </body>
    </html>
  `);
});

// 登录处理
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.loggedIn = true;
    res.redirect('/');
  } else {
    res.redirect('/login?error=1');
  }
});

// 登出
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// 保护后台相关路由
app.use(['/', '/logs', '/history-view', '/update-config', '/get-a00-al-price'], requireLogin);

// 主页
app.get("/", requireLogin, async (req, res) => {
  // 查询最近一次抓取和推送结果
  let lastData = null;
  let lastPush = null;
  let lastAlertCount = 0;
  await new Promise(resolve => {
    db.get('SELECT * FROM al_price_history ORDER BY id DESC LIMIT 1', [], (err, row) => {
      lastData = row;
      resolve();
    });
  });
  await new Promise(resolve => {
    db.get('SELECT * FROM alerts ORDER BY id DESC LIMIT 1', [], (err, row) => {
      lastPush = row;
      resolve();
    });
  });
  await new Promise(resolve => {
    db.get('SELECT COUNT(*) as cnt FROM alerts WHERE date(created_at)=date("now", "localtime")', [], (err, row) => {
      lastAlertCount = row ? row.cnt : 0;
      resolve();
    });
  });
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <title>铝价数据服务系统 - 主页</title>
      <style>
        body { font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; }
        .container { max-width: 800px; margin: 40px auto; background: #fff; border-radius: 8px; box-shadow: 0 2px 8px #ccc; padding: 30px; }
        h1 { text-align: center; margin-bottom: 30px; }
        .nav { display: flex; flex-wrap: wrap; justify-content: center; gap: 20px; margin-bottom: 30px; }
        .nav a { display: inline-block; padding: 18px 32px; background: #4CAF50; color: #fff; border-radius: 6px; text-decoration: none; font-size: 18px; font-weight: bold; transition: background 0.2s; }
        .nav a:hover { background: #388e3c; }
        .status { background: #f9f9f9; border-radius: 6px; padding: 18px 24px; margin-top: 20px; }
        .status-title { font-weight: bold; margin-bottom: 10px; }
        .status-row { margin-bottom: 6px; }
        .label { color: #888; margin-right: 8px; }
        .datetime { text-align: center; margin-top: 30px; color: #666; font-size: 16px; }
        .datetime span { font-weight: bold; color: #333; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>铝价数据服务系统</h1>
        <div class="nav">
          <a href="/alerts">警报系统</a>
          <a href="/history">历史数据（表格）</a>
          <a href="/history-view">历史数据（分析）</a>
          <a href="/get-a00-al-price">当前执行结果（表格）</a>
          <a href="/update-config">配置管理</a>
          <a href="/health-view">系统健康</a>
          <a href="/manage-tasks">配置抓取对象</a>
          <a href="/logs">系统日志</a>
        </div>
        <div class="status">
          <div class="status-title">系统状态</div>
          <div class="status-row"><span class="label">最近抓取时间:</span> ${lastData ? lastData.created_at : '无'}</div>
          <div class="status-row"><span class="label">最近均价:</span> ${lastData ? lastData.avgPrice : '无'}</div>
          <div class="status-row"><span class="label">最近推送警报:</span> ${lastPush ? lastPush.message : '无'}</div>
          <div class="status-row"><span class="label">今日异常警报数:</span> ${lastAlertCount}</div>
        </div>
        <div class="datetime">
          当前时间：<span id="currentTime"></span>
        </div>
      </div>
      <script>
        function updateTime() {
          const now = new Date();
          const options = { 
            year: 'numeric', 
            month: '2-digit', 
            day: '2-digit',
            hour: '2-digit', 
            minute: '2-digit', 
            second: '2-digit',
            hour12: false,
            timeZone: 'Asia/Shanghai'
          };
          document.getElementById('currentTime').textContent = now.toLocaleString('zh-CN', options);
        }
        updateTime();
        setInterval(updateTime, 1000);
      </script>
    </body>
    </html>
  `);
});

// 管理界面
app.get("/", requireLogin, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>铝价服务管理</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 20px auto; padding: 0 20px; }
        .container { background: #f5f5f5; padding: 20px; border-radius: 8px; }
        h1 { color: #333; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; }
        input[type="text"] { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; }
        button { background: #4CAF50; color: white; padding: 10px 20px; border: none; border-radius: 4px; cursor: pointer; }
        button:hover { background: #45a049; }
        .status { margin-top: 20px; padding: 10px; border-radius: 4px; }
        .success { background: #dff0d8; color: #3c763d; }
        .error { background: #f2dede; color: #a94442; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>铝价服务管理</h1>
        <form id="configForm">
          <div class="form-group">
            <label for="webhookUrl">Webhook URL:</label>
            <input type="text" id="webhookUrl" name="webhookUrl" value="${config.webhookUrl}" required>
          </div>
          <div class="form-group">
            <label for="webhookToken">Webhook Token:</label>
            <input type="text" id="webhookToken" name="webhookToken" value="${config.webhookToken}" required>
          </div>
          <div class="form-group">
            <label for="alertWebhookUrl">告警 Webhook URL:</label>
            <input type="text" id="alertWebhookUrl" name="alertWebhookUrl" value="${config.alertWebhookUrl || ''}" placeholder="可选，建议单独建群">
          </div>
          <div class="form-group">
            <label for="alertWebhookToken">告警 Webhook Token:</label>
            <input type="text" id="alertWebhookToken" name="alertWebhookToken" value="${config.alertWebhookToken || ''}" placeholder="可选">
          </div>
          <button type="submit">保存配置</button>
        </form>
        <div id="status" class="status" style="display: none;"></div>
      </div>
      <script>
        document.getElementById('configForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const status = document.getElementById('status');
          try {
            const response = await fetch('/update-config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                webhookUrl: document.getElementById('webhookUrl').value,
                webhookToken: document.getElementById('webhookToken').value,
                alertWebhookUrl: document.getElementById('alertWebhookUrl').value,
                alertWebhookToken: document.getElementById('alertWebhookToken').value
              })
            });
            const result = await response.json();
            status.textContent = result.message;
            status.className = 'status ' + (result.success ? 'success' : 'error');
            status.style.display = 'block';
          } catch (error) {
            status.textContent = '保存失败: ' + error.message;
            status.className = 'status error';
            status.style.display = 'block';
          }
        });
      </script>
    </body>
    </html>
  `);
});

// 更新配置API
app.post("/update-config", requireLogin, (req, res) => {
  const { webhookUrl, webhookToken, alertWebhookUrl, alertWebhookToken } = req.body;
  if (!webhookUrl || !webhookToken) {
    return res.json({ success: false, message: 'Webhook URL和Token不能为空' });
  }
  config = { webhookUrl, webhookToken, alertWebhookUrl, alertWebhookToken };
  if (saveConfig(config)) {
    res.json({ success: true, message: '配置已更新' });
  } else {
    res.json({ success: false, message: '配置更新失败' });
  }
});

// 获取所有日志文件
app.get('/logs', (req, res) => {
    console.log('__dirname:', __dirname);
    const files = fs.readdirSync(__dirname);
    console.log('当前目录文件:', files);
    const logFiles = files
        .filter(file => file.startsWith('app-') && file.endsWith('.log'))
        .map(file => file.replace('app-', '').replace('.log', ''));
    console.log('LogViewer可用日志文件:', logFiles);
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Log Viewer</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 20px; }
                select { margin-bottom: 20px; }
                pre { background-color: #f4f4f4; padding: 10px; }
            </style>
        </head>
        <body>
            <h1>Log Viewer</h1>
            <select id="logDate" onchange="loadLog()">
                <option value="">Select a date</option>
                ${logFiles.map(date => `<option value="${date}">${date}</option>`).join('')}
            </select>
            <pre id="logContent"></pre>

            <script>
                function loadLog() {
                    const date = document.getElementById('logDate').value;
                    if (date) {
                        fetch('/logs/' + date)
                            .then(response => response.text())
                            .then(data => {
                                document.getElementById('logContent').textContent = data;
                            })
                            .catch(error => {
                                console.error('Error loading log:', error);
                            });
                    } else {
                        document.getElementById('logContent').textContent = '';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// 获取指定日期的日志
app.get('/logs/:date', (req, res) => {
    const date = req.params.date;
    const logFileName = `app-${date}.log`;
    const logFilePath = path.join(__dirname, logFileName);

    fs.readFile(logFilePath, 'utf8', (err, data) => {
        if (err) {
            return res.status(500).send('Error reading log file');
        }
        res.send(data);
    });
});

// /history-view 页面
app.get('/history-view', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'history-view.html'));
});

// /history-view/api 数据接口
app.get('/history-view/api', requireLogin, (req, res) => {
  const { startDate, endDate, name } = req.query;
  let sql = 'SELECT * FROM al_price_history WHERE 1=1';
  const params = [];
  if (startDate) {
    sql += ' AND date >= ?';
    params.push(Number(startDate));
  }
  if (endDate) {
    sql += ' AND date <= ?';
    params.push(Number(endDate));
  }
  if (name) {
    sql += ' AND name = ?';
    params.push(name);
  }
  sql += ' ORDER BY date DESC, id DESC LIMIT 100';
  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ data: rows });
  });
});

const db = new sqlite3.Database(DB_FILE);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS al_price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    priceRange TEXT,
    avgPrice REAL,
    change REAL,
    unit TEXT,
    date INTEGER,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  )`, (err) => {
    if (err) {
      console.error('建表失败:', err.message);
    } else {
      console.log('al_price_history 表已确保存在');
    }
  });
});

// 告警表
const ALERT_DB_INIT = `CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,
  message TEXT,
  created_at TEXT DEFAULT (datetime('now', 'localtime'))
)`;
db.serialize(() => { db.run(ALERT_DB_INIT); });

function addAlert(type, message) {
  db.run('INSERT INTO alerts (type, message) VALUES (?, ?)', [type, message]);
  writeLog(`[ALERT][${type}] ${message}`);
}

function sendFeishuAlert(msg) {
  const url = config.alertWebhookUrl || config.webhookUrl;
  const token = config.alertWebhookToken || config.webhookToken;
  if (!url || !token) {
    writeLog('[ALERT] 未配置警报Webhook，未发送飞书警报: ' + msg);
    return;
  }
  axios.post(
    url,
    {
      msg_type: 'text',
      content: { text: `[异常警报] ${msg}` }
    },
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  ).catch(e => {
    writeLog('[ALERT] 飞书警报发送失败: ' + e.message);
  });
}

// 新增警报页面
app.get('/alerts', requireLogin, (req, res) => {
  db.all('SELECT * FROM alerts ORDER BY id DESC LIMIT 100', [], (err, rows) => {
    if (err) return res.status(500).send('数据库错误');
    res.send(`
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <meta charset="UTF-8">
        <title>异常警报</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          table { border-collapse: collapse; width: 100%; }
          th, td { border: 1px solid #ccc; padding: 8px; text-align: center; }
          th { background: #f5f5f5; }
        </style>
      </head>
      <body>
        <h1>异常警报</h1>
        <table>
          <thead><tr><th>ID</th><th>类型</th><th>内容</th><th>时间</th></tr></thead>
          <tbody>
            ${rows.map(r => `<tr><td>${r.id}</td><td>${r.type}</td><td>${r.message}</td><td>${r.created_at}</td></tr>`).join('')}
          </tbody>
        </table>
      </body>
      </html>
    `);
  });
});

// 健康检查 API
app.get('/health', requireLogin, async (req, res) => {
  // 检查数据库
  let dbOk = false;
  try {
    await new Promise((resolve, reject) => {
      db.get('SELECT 1', [], (err) => err ? reject(err) : resolve());
    });
    dbOk = true;
  } catch {}
  // 检查 webhook
  let webhookOk = false;
  try {
    if (config.webhookUrl && config.webhookToken) {
      await axios.options(config.webhookUrl, { headers: { 'Authorization': `Bearer ${config.webhookToken}` } });
      webhookOk = true;
    }
  } catch {}
  // 检查最近抓取
  let lastFetch = null;
  await new Promise(resolve => {
    db.get('SELECT * FROM al_price_history ORDER BY id DESC LIMIT 1', [], (err, row) => {
      lastFetch = row;
      resolve();
    });
  });
  res.json({
    db: dbOk,
    webhook: webhookOk,
    lastFetch,
    time: formatDateTime(new Date())
  });
});

// 健康检查可视化页面
app.get('/health-view', requireLogin, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <title>系统健康检查</title>
      <style>
        body { font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; }
        .container { max-width: 700px; margin: 40px auto; background: #fff; border-radius: 8px; box-shadow: 0 2px 8px #ccc; padding: 30px; }
        h1 { text-align: center; margin-bottom: 30px; }
        .card-list { display: flex; flex-wrap: wrap; gap: 24px; justify-content: center; }
        .card { flex: 1 1 220px; background: #f9f9f9; border-radius: 8px; box-shadow: 0 1px 4px #eee; padding: 24px; min-width: 220px; text-align: center; }
        .card-title { font-size: 18px; color: #888; margin-bottom: 10px; }
        .card-value { font-size: 22px; font-weight: bold; margin-bottom: 6px; }
        .ok { color: #4CAF50; }
        .fail { color: #e53935; }
        .time { color: #888; font-size: 14px; margin-top: 20px; text-align: right; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>系统健康检查</h1>
        <div class="card-list" id="healthCards"></div>
        <div class="time" id="healthTime"></div>
      </div>
      <script>
        fetch('/health').then(r => r.json()).then(function(result) {
          const cards = [
            { title: '数据库连接', value: result.db ? '正常' : '异常', ok: result.db },
            { title: 'Webhook连通性', value: result.webhook ? '正常' : '异常', ok: result.webhook },
            { title: '最近抓取时间', value: result.lastFetch ? result.lastFetch.created_at : '无', ok: !!result.lastFetch },
            { title: '最近均价', value: result.lastFetch ? result.lastFetch.avgPrice : '无', ok: !!result.lastFetch }
          ];
          document.getElementById('healthCards').innerHTML = cards.map(function(card) {
            return '<div class="card"><div class="card-title">' + card.title + '</div><div class="card-value ' + (card.ok ? 'ok' : 'fail') + '">' + card.value + '</div></div>';
          }).join('');
          document.getElementById('healthTime').textContent = '检查时间：' + result.time;
        });
      </script>
    </body>
    </html>
  `);
});

// 管理抓取对象 API
app.get('/tasks', requireLogin, (req, res) => {
  res.json({ tasks: config.tasks || [] });
});
app.post('/tasks', requireLogin, (req, res) => {
  const { name, url, selector } = req.body;
  if (!name || !url || !selector) {
    return res.json({ success: false, message: '品名、网址、选择器不能为空' });
  }
  config.tasks = config.tasks || [];
  if (config.tasks.find(t => t.name === name)) {
    return res.json({ success: false, message: '已存在同名品种' });
  }
  config.tasks.push({ name, url, selector });
  if (saveConfig(config)) {
    res.json({ success: true, message: '添加成功', tasks: config.tasks });
  } else {
    res.json({ success: false, message: '保存失败' });
  }
});
app.put('/tasks', requireLogin, (req, res) => {
  const { oldName, name, url, selector } = req.body;
  if (!oldName || !name || !url || !selector) {
    return res.json({ success: false, message: '参数不完整' });
  }
  config.tasks = config.tasks || [];
  const idx = config.tasks.findIndex(t => t.name === oldName);
  if (idx === -1) return res.json({ success: false, message: '未找到原品种' });
  config.tasks[idx] = { name, url, selector };
  if (saveConfig(config)) {
    res.json({ success: true, message: '修改成功', tasks: config.tasks });
  } else {
    res.json({ success: false, message: '保存失败' });
  }
});
app.delete('/tasks', requireLogin, (req, res) => {
  const { name } = req.body;
  if (name === 'A00铝') {
    return res.json({ success: false, message: '主任务A00铝不可删除' });
  }
  config.tasks = config.tasks || [];
  const idx = config.tasks.findIndex(t => t.name === name);
  if (idx === -1) return res.json({ success: false, message: '未找到品种' });
  config.tasks.splice(idx, 1);
  if (saveConfig(config)) {
    res.json({ success: true, message: '删除成功', tasks: config.tasks });
  } else {
    res.json({ success: false, message: '保存失败' });
  }
});

// 管理抓取对象页面
app.get('/manage-tasks', requireLogin, (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
      <meta charset="UTF-8">
      <title>配置抓取对象</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .container { max-width: 800px; margin: 0 auto; background: #fff; border-radius: 8px; box-shadow: 0 2px 8px #ccc; padding: 30px; }
        h1 { text-align: center; margin-bottom: 30px; }
        table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
        th, td { border: 1px solid #ccc; padding: 8px; text-align: center; }
        th { background: #f5f5f5; }
        .form-row { display: flex; gap: 12px; margin-bottom: 18px; }
        .form-row input { flex: 1; padding: 8px; border: 1px solid #ccc; border-radius: 4px; }
        .form-row button { padding: 8px 18px; background: #4CAF50; color: #fff; border: none; border-radius: 4px; cursor: pointer; }
        .form-row button:hover { background: #388e3c; }
        .edit-btn, .del-btn { padding: 4px 12px; border: none; border-radius: 4px; cursor: pointer; }
        .edit-btn { background: #2196F3; color: #fff; }
        .edit-btn:hover { background: #1565c0; }
        .del-btn { background: #e53935; color: #fff; margin-left: 8px; }
        .del-btn:hover { background: #b71c1c; }
        .msg { margin-bottom: 16px; color: #e53935; }
        .success { color: #4CAF50; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>配置抓取对象</h1>
        <div id="msg" class="msg"></div>
        <div class="form-row">
          <input type="text" id="name" placeholder="品名，如A00铝">
          <input type="text" id="url" placeholder="目标网址">
          <input type="text" id="selector" placeholder="选择器关键字，如A00铝">
          <button onclick="addTask()" id="addBtn">添加</button>
        </div>
        <table>
          <thead><tr><th>品名</th><th>目标网址</th><th>选择器</th><th>操作</th></tr></thead>
          <tbody id="taskTable"></tbody>
        </table>
      </div>
      <script src="/manage-tasks.js"></script>
    </body>
    </html>
  `);
});

// 启动时检查是否需要补抓
(async () => {
  const now = new Date();
  const currentHour = now.getHours();

  if (currentHour >= 10 && isWorkday()) {
    const todayNum = getTodayNum();
    const db = new sqlite3.Database(DB_FILE);
    const hasTodayData = await new Promise(resolve => {
      db.get('SELECT * FROM al_price_history WHERE date = ?', [todayNum], (err, row) => {
        if (err) {
          writeLog(`[Startup] 检查当日数据失败: ${err.message}`);
          resolve(false);
        } else {
          resolve(!!row);
        }
      });
    });

    if (!hasTodayData) {
      writeLog(`[Startup] 当前为 ${formatDateTime(now)}，已过10点且无数据，立即启动抓取`);
      await smartFetchAll();
    } else {
      writeLog(`[Startup] 当前为 ${formatDateTime(now)}，数据已存在，启动监控`);
      startRetryLoop();
    }
  } else {
    writeLog(`[Startup] 当前为 ${formatDateTime(now)}，尚未到10点或不是工作日，等待定时任务`);
  }
})();

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
