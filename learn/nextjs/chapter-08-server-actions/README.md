# 第 08 章 · Server Actions 与表单提交

独立、完整、可单独运行的 Next.js 项目，演示 Server Actions 与表单提交的核心用法。

---

## 如何运行

```bash
# 进入本章目录
cd learn/nextjs/chapter-08-server-actions

# 安装依赖
npm install        # 或 pnpm install / yarn

# 启动开发服务器
npm run dev        # 访问 http://localhost:3000
```

生产构建：

```bash
npm run build
npm run start
```

---

## 本项目文件清单与作用

| 文件 | 必需 | 说明 |
|------|:----:|------|
| `src/app/layout.tsx` | 是 | 根布局，引入 `globals.css`，提供全局样式类（`card`/`demo-box`/`muted`/`tag`/`btn`）。骨架文件，**勿修改**。 |
| `src/app/globals.css` | 是 | 全局 CSS 变量与基础样式。骨架文件，**勿修改**。 |
| `src/app/page.tsx` | 是 | 根路由 `/` 的页面。**async 服务端组件**：直接 `await getMessages()` 获取留言列表，渲染页面内容并嵌入 `<MessageForm />`。 |
| `src/app/actions.ts` | 是 | **带文件级 `"use server"` 的服务端动作文件**。本文件所有导出函数都只在服务器执行，不进入客户端 bundle。包含 `addMessage`（Server Action，处理表单提交、校验输入、调用 `revalidatePath('/')`）和 `getMessages`（普通 async 函数，供服务端组件直接调用读取数据）。 |
| `src/app/MessageForm.tsx` | 是 | **带 `"use client"` 的客户端组件**。使用 React 19 的 `useActionState(addMessage, initialState)` hook 管理表单状态：`state`（action 返回值）、`formAction`（传给 `<form action>`）、`isPending`（提交中禁用按钮）。 |
| `package.json` | 是 | 项目依赖与脚本。骨架文件。 |
| `next.config.mjs` | 是 | Next.js 配置。骨架文件。 |
| `tsconfig.json` | 是 | TypeScript 配置。骨架文件。 |
| `notes.md` | 否 | 本章知识点笔记，详细讲解所有核心概念、常见坑与练习题。 |

---

## 要点摘要

### Server Action 的本质

带 `"use server"` 标记的 async 函数在服务器上执行，Next.js 构建时为每个 action 生成唯一 POST 端点。客户端"调用"它时，实际上是发起了一次 HTTP POST 请求。

### 完整数据流

```
用户填写留言
  → <form action={formAction}> 提交
  → useActionState 拦截，调用 addMessage(prevState, formData)
  → addMessage 在服务器执行：校验 → 写入 messages 数组 → revalidatePath('/')
  → React 触发重新渲染，page.tsx 重新执行 await getMessages()
  → 最新留言列表出现在页面
```

### `"use server"` 两种位置

- **文件顶部**（本项目用法）：整个文件所有导出函数都是 Server Action，适合集中管理多个 action。
- **函数内内联**：只标记单个函数，适合在服务端组件内就地定义、捕获外层变量（闭包）。

### `useActionState` 三个返回值

```typescript
const [state, formAction, isPending] = useActionState(action, initialState);
//     ↑状态    ↑传给form   ↑提交中为true
```

### 安全原则

Server Action 是公开的 HTTP 端点，**必须在 action 内部做输入校验与身份验证**，不能依赖前端的隐藏按钮或 disabled 属性。

---

## dev 内存重置说明

本章使用模块级数组 `messages: string[]` 作为临时存储。在 dev 模式（`next dev`）下，每次热重载（HMR）都会重新执行模块，数组清空为 `[]`——**这是正常现象，不是 bug**。生产模式下单进程内数据持久，但多实例部署时各实例内存不共享。真实项目应使用数据库持久化。

---

## 延伸阅读

详细知识点、常见坑、练习题见 [notes.md](./notes.md)。
