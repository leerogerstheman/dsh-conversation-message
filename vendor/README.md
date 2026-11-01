# vendor

宿主里解析不到 `@deepseek-ai/schemastery` 时的兜底副本。插件只用它给「设置 → 插件」
提供带 `volatile` 标记的配置表单；解析不到时插件照常工作，只是没有表单。

| 文件 | 来源 | 说明 |
|---|---|---|
| `schemastery.mjs` | `@deepseek-ai/schemastery` 3.18.5（取自本机 DSH `app.asar`） | 仅把首行 `from "@deepseek-ai/cosmokit"` 改成 `./cosmokit.mjs` |
| `cosmokit.mjs` | `@deepseek-ai/cosmokit` 1.8.6 | 无任何 import，可直接当 ESM 用 |
| `LICENSE.schemastery.txt` / `LICENSE.cosmokit.txt` | 两个包的 MIT 许可原文 | Copyright (c) 2021-present Shigma |

`index.js` 的加载顺序是**先宿主、后 vendor**：

```js
for (const spec of ['@deepseek-ai/schemastery', './vendor/schemastery.mjs']) { ... }
```
