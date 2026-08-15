# PerpScope

聚合 Binance、Bitget、Gate、Bybit、OKX 与 Hyperliquid 的美股和韩股永续合约标记价，按跨交易所价差排序。

## 功能

- 美股 / 韩股筛选、搜索与报价数量过滤
- 按价差百分比、绝对价差、报价数量或股票代码排序
- 展开查看六家交易所逐项报价
- 美股休市期间每 5 分钟自动刷新；开市期间暂停轮询
- 单家交易所异常时继续展示其余可用行情

## 本地运行

```bash
npm install
npm run dev
```

生产构建与校验：

```bash
npm test
npm run lint
```

行情来自各交易所公开接口，仅供监控参考。
