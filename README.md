# 铝价数据服务系统

## 功能特点

- 自动抓取铝价数据
- 支持多个品种同时抓取
- 数据自动推送到飞书
- 异常情况自动警报
- 历史数据查询和分析
- 系统健康监控
- 完整的日志记录

## 系统要求

- Node.js 18+
- Docker
- 飞书机器人 Webhook

## 快速开始

1. 克隆代码：
```bash
git clone [仓库地址]
cd puppeteer-al-price
```

2. 安装依赖：
```bash
npm install
```

3. 配置：
   - 复制 `config.example.json` 为 `config.json`
   - 填写飞书 Webhook 配置
   - 配置抓取任务

4. 启动服务：
```bash
npm start
```

## Docker 部署

1. 构建镜像：
```bash
docker build -t puppeteer-al-price .
```

2. 运行容器：
```bash
docker run -d --name puppeteer-al-price -p 3003:3003 puppeteer-al-price
```

## 功能说明

### 1. 数据抓取
- 每天早上 10 点自动抓取
- 支持多个品种同时抓取
- 抓取失败自动重试
- 数据异常自动警报

### 2. 数据推送
- 自动推送到飞书
- 支持多个 Webhook
- 推送失败自动重试
- 异常情况自动警报

### 3. 历史数据
- 表格形式查看
- 图表形式分析
- 支持按日期筛选
- 支持按品种筛选

### 4. 系统监控
- 数据库连接状态
- Webhook 连通性
- 最近抓取时间
- 最近均价数据

### 5. 日志系统
- 按日期记录日志
- 支持查看历史日志
- 记录所有操作和异常
- 自动清理过期日志

### 6. 警报系统
- 抓取失败警报
- 数据异常警报
- 推送失败警报
- 系统异常警报

## 配置说明

### config.json
```json
{
  "webhookUrl": "飞书 Webhook URL",
  "webhookToken": "飞书 Webhook Token",
  "alertWebhookUrl": "警报 Webhook URL（可选）",
  "alertWebhookToken": "警报 Webhook Token（可选）",
  "tasks": [
    {
      "name": "A00铝",
      "url": "https://www.ccmn.cn/",
      "selector": "A00铝"
    }
  ]
}
```

## 访问地址

- 主页：`http://localhost:3003/`
- 历史数据：`http://localhost:3003/history`
- 数据分析：`http://localhost:3003/history-view`
- 系统健康：`http://localhost:3003/health-view`
- 系统日志：`http://localhost:3003/logs`
- 警报系统：`http://localhost:3003/alerts`
- 配置管理：`http://localhost:3003/update-config`

## 开发说明

### 目录结构
```
puppeteer-al-price/
├── index.js          # 主程序
├── config.json       # 配置文件
├── package.json      # 依赖配置
├── Dockerfile        # Docker 配置
├── public/           # 静态资源
└── logs/            # 日志文件
```

### 开发环境
```bash
# 安装依赖
npm install

# 启动开发服务
npm run dev

# 运行测试
npm test
```

## 更新日志

### v1.0.0 (2025-05-27)
- 初始版本发布
- 支持基本的数据抓取和推送
- 支持历史数据查询
- 支持系统监控
- 支持日志记录
- 支持警报系统

## 贡献指南

1. Fork 本仓库
2. 创建特性分支
3. 提交代码
4. 创建 Pull Request

## 许可证

MIT License
