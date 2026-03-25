# Custom Templates Example

这个示例展示 framework 的两个扩展点：

1. 复用默认模板
2. 追加自己的模板注册

运行：

```bash
node examples/custom-templates/server.js
```

重点看这里：

- `templates: [...]`
- 每个模板都提供 `id / title / description / build(workspaceRoot)`
- `build()` 返回 room preset：
  - `sessions`
  - `roomTitle`
  - `instruction`
  - `seedMessage`
