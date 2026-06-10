# 第 06 章 · 路由处理程序（Route Handlers / API Routes）

本项目是 Next.js 第 06 章的独立可运行示例，演示如何使用 App Router 的路由处理程序创建 HTTP API 接口。

---

## 如何运行

```bash
# 进入项目目录
cd learn/nextjs/chapter-06-route-handlers

# 安装依赖（仅首次）
npm install
# 或 pnpm install / yarn install

# 启动开发服务器
npm run dev

# 浏览器打开
# http://localhost:3000
```

访问 `http://localhost:3000` 即可看到演示页面，页面上提供三个可交互的按钮，分别调用以下接口：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/hello?name=张三` | GET | 读取查询参数，返回问候语 |
| `/api/hello` | POST | 读取 JSON 请求体，原样回显 |
| `/api/time` | GET | 返回当前服务器时间 |

---

## 文件清单与作用

| 文件路径 | 必需 | 说明 |
|----------|------|------|
| `src/app/layout.tsx` | 必需（骨架） | 根布局，引入全局样式，提供 `card`/`demo-box`/`muted`/`tag`/`btn` 等全局 CSS 类 |
| `src/app/globals.css` | 必需（骨架） | 全局样式，定义 CSS 变量和公共类名 |
| `src/app/page.tsx` | **必需** | 根路由 `/` 的页面（客户端组件），包含三个交互示例 |
| `src/app/api/hello/route.ts` | **必需** | 后端接口文件，定义 `GET /api/hello` 和 `POST /api/hello` 两个 HTTP 接口 |
| `src/app/api/time/route.ts` | **必需** | 后端接口文件，定义 `GET /api/time`，返回服务器当前时间 |
| `package.json` | 必需（骨架） | 项目依赖声明 |
| `next.config.mjs` | 必需（骨架） | Next.js 配置文件 |
| `tsconfig.json` | 必需（骨架） | TypeScript 配置 |
| `notes.md` | 参考 | 本章知识点详细笔记 |

### 关于 `route.ts` 文件

文件名固定为 **`route.ts`**（或 `route.js`），这是 Next.js App Router 识别后端接口的约定：

- `src/app/api/hello/route.ts` — 文件路径对应 URL `/api/hello`，在其中导出 `GET` 和 `POST` 函数，就分别定义了这两个 HTTP 方法的接口处理逻辑。
- `src/app/api/time/route.ts` — 文件路径对应 URL `/api/time`，导出 `GET` 函数定义 GET 接口。

路由文件路径与 URL 的对应规律：`src/app` 之后的目录结构即为 URL 路径，`route.ts` 本身不出现在 URL 中。

### route.ts 与 page.tsx 不能共存的规则

**同一路由段下，`route.ts` 与 `page.tsx` 不能共存。** 这是 Next.js 的强制约束：同一目录不能既是"页面"又是"接口"。

```
❌ 错误：同一目录下同时有 page.tsx 和 route.ts
src/app/users/
  ├── page.tsx   ← 页面
  └── route.ts   ← 接口（与 page.tsx 冲突，构建会报错）

✅ 正确：接口放到不同的路由段（子目录）
src/app/
  ├── page.tsx               ← 根页面，URL: /
  └── api/
      ├── hello/
      │   └── route.ts       ← 接口，URL: /api/hello
      └── time/
          └── route.ts       ← 接口，URL: /api/time
```

不同路由段（不同目录）下的 `route.ts` 与 `page.tsx` 可以自由共存，互不影响。本项目的 `src/app/page.tsx`（页面）和 `src/app/api/hello/route.ts`（接口）正是这种结构。

---

## 要点摘要

1. **文件名即约定**：`route.ts` = 接口，`page.tsx` = 页面，两者在同一目录下不能共存。
2. **方法名即函数名**：`GET`、`POST`、`PUT`、`DELETE` 等，全大写导出，Next.js 自动路由。
3. **读取查询参数**：`new URL(request.url).searchParams.get('key')`，无需额外 import。
4. **读取请求体**：`await request.json()`，注意必须 `await`，建议 `try/catch`。
5. **返回 JSON**：`Response.json(data)` 是 Web 标准 API，Next.js 15 直接支持，无需 import。
6. **动态模式**：接口加 `export const dynamic = 'force-dynamic'` 可防止缓存，每次请求都重新执行。

---

## 延伸阅读

详细知识点、代码示例和常见坑见 [notes.md](./notes.md)。

官方文档：[Next.js Route Handlers](https://nextjs.org/docs/app/building-your-application/routing/route-handlers)
